/**
 * QUANTAREON Voice — голос платформы на сайте quantareon.com
 * (копия realtime-модуля платформы, адреса переведены на сервер Амверы)
 * Голосовой помощник — работает с voice-master WebSocket протоколом
 * 
 * Кнопка 🤖 включает/выключает голосовой режим
 * Транскрипт идёт в чат платформы
 * 
 * ФИКСЫ v1.2:
 * - Одна сессия — невозможно открыть несколько голосов
 * - Корректное включение/выключение с полной очисткой
 * - Филлеры не повторяются (server-side через skip_filler)
 * - Barge-in работает правильно
 */

(function() {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================
    // 📦 Хранилище с файлами голоса (Cloudflare R2, свой домен).
    // Всё, что раньше тянулось с зарубежных сайтов, лежит здесь.
    const ASSETS = 'https://media.quantareon.com/';

    const CONFIG = {
        // WebSocket URL — тот же сервер (unified)
        // 🎙 Голосовой Квантареон живёт на Render рядом с движком Астро-Фрактала.
        // Перенесён с Амверы 01.08.2026 — у неё развалилась сеть.
        SERVER: 'https://voice.quantareon.com',
        WS_URL: 'wss://voice.quantareon.com/ws/voice',
        
        // VAD настройки
        VAD_POSITIVE_THRESHOLD: 0.57,
        VAD_NEGATIVE_THRESHOLD: 0.25,
        // 26 вместо 15: сколько кадров тишины держим, прежде чем считать
        // фразу законченной. Кадр ~32 мс, значит ждём ~1.1 сек вместо 0.48.
        // Раньше короткая пауза внутри мысли обрывала фразу пополам.
        VAD_REDEMPTION_FRAMES: 34,
        VAD_MIN_SPEECH_FRAMES: 8,
        VAD_DEBOUNCE_MS: 350,
        VAD_DEBOUNCE_MS_SPEAKING_MOBILE: 1300,   // на телефоне, пока помощник говорит
        VAD_DEBOUNCE_MS_SPEAKING_DESKTOP: 750,   // на компьютере — колонки тоже слышны микрофону
        VAD_MIN_DURATION_MS: 350,   // короче — реже теряем быстрые реплики
        
        // Watchdog & reconnect
        WATCHDOG_MS: 30000,
        RECONNECT_MS: 3000,
        PING_INTERVAL_MS: 10000
    };

    // 👑 Секретный ключ хозяина: один раз открыть сайт как ?key=СЕКРЕТ —
    // ключ запомнится в этом браузере и дальше уходит на сервер сам.
    // Гостям он неизвестен, поэтому их помощник знает как гостей.
    let OWNER_KEY = '';
    try {
        const _q = new URLSearchParams(location.search).get('key');
        if (_q) { localStorage.setItem('qOwnerKey', _q); }
        OWNER_KEY = localStorage.getItem('qOwnerKey') || '';
    } catch (e) { OWNER_KEY = ''; }

    // ⏳ Если ответ долго не приходит — говорим об этом, а не молчим.
    // Раньше тишина выглядела как зависание.
    let waitTimer = null;
    function startWaitNotice() {
        stopWaitNotice();
        waitTimer = setTimeout(function () {
            if (typeof showToast === 'function') showToast('🤖 Думаю…');
            waitTimer = setTimeout(function () {
                if (typeof showToast === 'function') showToast('🤖 Долго думаю — сейчас отвечу');
            }, 9000);
        }, 6000);
    }
    function stopWaitNotice() {
        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    }


    // ☕ Render на бесплатном тарифе засыпает после простоя и просыпается
    // до минуты. Будим его заранее, как только страница открылась, —
    // чтобы к моменту клика по имени он уже был на ногах.
    (function wakeServer() {
        try {
            fetch('https://voice.quantareon.com/health',
                  { mode: 'no-cors', cache: 'no-store' }).catch(function(){});
        } catch (e) {}
    })();

    // 🕐 Часовой пояс берём У БРАУЗЕРА: он знает настоящий, а определение
    // по адресу в сети врёт при VPN и у провайдеров с чужими адресами.
    let USER_TZ = '';
    try { USER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

    // Язык берём у самой страницы (<html lang="ru"> / "en")
    const LANG = String(document.documentElement.lang || 'ru').toLowerCase().indexOf('en') === 0 ? 'en' : 'ru';

    // ═══ 🔀 ПЕРЕКЛЮЧАТЕЛЬ МОДЕЛИ — только для хозяина ═══
    // Кнопки «быстрая»/«умная» СОЗДАЮТСЯ КОДОМ и только тогда, когда сервер
    // признал ключ хозяина. В разметке страницы их нет вовсе — гость не найдёт
    // их даже в исходнике. Выбор общий: переключил — стало у всех, потому что
    // модель хранится на сервере, а не в браузере.
    (function initModelSwitch() {
        if (!OWNER_KEY) return;                   // нет ключа — ничего не строим

        var MODEL_ID = { small: 'openai/gpt-oss-20b', big: 'openai/gpt-oss-120b' };
        var LABEL = (LANG === 'en') ? { small: 'fast', big: 'smart' }
                                    : { small: 'быстрая', big: 'умная' };
        var box = null, btns = [];

        function build() {
            var head = document.querySelector('.vchat-head');
            var close = document.querySelector('.vchat-close');
            if (!head || document.getElementById('mswitch')) return false;

            box = document.createElement('span');
            box.className = 'mswitch on';
            box.id = 'mswitch';
            box.title = (LANG === 'en') ? 'Answer model — visible to you only'
                                        : 'Модель ответов — видно только вам';

            ['small', 'big'].forEach(function (k) {
                var b = document.createElement('button');
                b.type = 'button';
                b.setAttribute('data-model', k);
                b.textContent = LABEL[k];
                b.addEventListener('click', function () { switchTo(k); });
                box.appendChild(b);
                btns.push(b);
            });

            head.insertBefore(box, close);
            return true;
        }

        function mark(currentId) {
            btns.forEach(function (b) {
                b.classList.toggle('active', currentId === MODEL_ID[b.getAttribute('data-model')]);
            });
        }

        function switchTo(want) {
            btns.forEach(function (x) { x.disabled = true; });
            fetch(CONFIG.SERVER + '/api/voice-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: OWNER_KEY, model: want })
            })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.current) {
                    mark(d.current);
                    if (typeof showToast === 'function')
                        showToast(want === 'big'
                            ? (LANG === 'en' ? '🧠 Smart model' : '🧠 Умная модель')
                            : (LANG === 'en' ? '⚡ Fast model'  : '⚡ Быстрая модель'));
                }
            })
            .catch(function () {})
            .then(function () { btns.forEach(function (x) { x.disabled = false; }); });
        }

        // спрашиваем сервер: признаёт ли он ключ. Признал — строим кнопки.
        fetch(CONFIG.SERVER + '/api/voice-model?key=' + encodeURIComponent(OWNER_KEY))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.owner) return;       // не хозяин — кнопок не будет
                if (build()) mark(d.current || '');
            })
            .catch(function () {});
    })();

    const TXT = {
        ru: {
            connecting: '🤖 Подключение к серверу…',
            ready:      '🤖 Голосовой помощник готов — говорите!',
            starting:   '🤖 Запуск голосового помощника…',
            stopped:    '🤖 Голосовой помощник выключен',
            greetWait:  '🤖 Приветствие… микрофон включится следом',
            reset:      '🔄 Контекст сброшен',
            micDenied:  '❌ Микрофон запрещён. Разрешите доступ в настройках браузера для этого сайта.',
            micMissing: '❌ Микрофон не найден.',
            micBusy:    '❌ Микрофон занят другим приложением.',
            vadFail:    '❌ Не загрузился распознаватель речи — проверьте интернет.',
            unknown:    'неизвестная ошибка',
            greetText:  'Я Квантареон, голосовой помощник этого сайта. Спрашивай, что тебя интересует.'
        },
        en: {
            connecting: '🤖 Connecting to the server…',
            ready:      '🤖 Voice assistant ready — go ahead!',
            starting:   '🤖 Starting the voice assistant…',
            stopped:    '🤖 Voice assistant switched off',
            greetWait:  '🤖 Greeting… the microphone starts next',
            reset:      '🔄 Context cleared',
            micDenied:  '❌ Microphone blocked. Allow access for this site in your browser settings.',
            micMissing: '❌ No microphone found.',
            micBusy:    '❌ The microphone is busy in another app.',
            vadFail:    '❌ Speech detector failed to load — check your connection.',
            unknown:    'unknown error',
            greetText:  'I am Quantareon, the voice assistant of this site. Ask me anything you like.'
        }
    };
    const T = TXT[LANG];

    // Телефон? На нём динамик бьёт прямо в микрофон, и помощник слышит сам себя
    const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
                      || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    // Кроссбраузерный AudioContext (старые iOS понимают только с префиксом)
    const ACtx = window.AudioContext || window.webkitAudioContext;

    // 🔓 Разблокировка звука — вызывается СИНХРОННО из касания пользователя.
    // Без этого iOS/Android держат звук выключенным: касание — единственный
    // момент, когда браузер разрешает включить аудио.
    let unlockCtx = null;
    let разрешённыйЭлемент = null;   // 🔓 аудио-элемент, разбуженный касанием

    function unlockAudio() {
        try {
            if (!unlockCtx) unlockCtx = new ACtx();
            if (unlockCtx.state === 'suspended') unlockCtx.resume();
            const b = unlockCtx.createBuffer(1, 1, 22050);
            const s = unlockCtx.createBufferSource();
            s.buffer = b; s.connect(unlockCtx.destination); s.start(0);
        } catch (e) { console.warn('🎙 unlock failed', e); }

        // 🔓 ГЛАВНОЕ ДЛЯ ТЕЛЕФОНА: браузер разрешает играть звук ТОЛЬКО в тот
        // миг, когда человек коснулся экрана. Если мы сначала пойдём качать
        // приветствие, разрешение «протухнет», и звук уже не запустится —
        // отсюда была тишина при идущих волнах.
        // Поэтому прямо сейчас, внутри касания, заводим аудио-элемент и
        // проигрываем в нём тишину. Элемент становится «разрешённым»,
        // и позже мы просто подменим ему источник на приветствие.
        try {
            if (!разрешённыйЭлемент) {
                разрешённыйЭлемент = new Audio(
                    'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD/////////////////////////AAAAAExhdmM1OC4xMwAAAAAAAAAAAAAAACQEAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
                разрешённыйЭлемент.play().catch(function () {});
            }
        } catch (e) {}
    }

    // ============================================================
    // STATE — единственный экземпляр
    // ============================================================
    let ws = null;
    let isActive = false;
    let isStarting = false;      // 🛡️ Защита от двойного старта
    let isBotSpeaking = false;
    let isPlaying = false;
    let sttReady = false;
    let bargeInTriggered = false;
    let userInitiatedStop = false;

    // Audio
    let micStream = null;
    let vadStream = null;
    let audioCtx = null;
    let scriptProc = null;
    let sileroVAD = null;
    let audioQueue = [];
    let currentAudio = null;
    let currentEl = null;           // 🔊 аудио-элемент текущего куска ответа (телефон)

    // VAD
    let speechTimer = null;
    let speechConfirmed = false;
    let speechStart = 0;
    let watchdog = null;
    let lastActivity = Date.now();
    let pingInterval = null;

    // Текущий ответ ассистента (собираем по чанкам)
    let currentResponse = '';
    let микМакс = 0, микКогда = 0, микТихо = 0;   // 🎤 самопроверка микрофона

    // 📨 Короткая весточка серверу — попадает в дневник событий.
    // Нужна, чтобы видеть со стороны, докуда дошёл запуск на телефоне.
    function сообщить(текст) {
        try {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'mic', note: String(текст) }));
            }
        } catch (e) {}
    }

    // 🔒 Филлеры — отслеживаем чтобы не повторялись
    let cachedGreeting = null;
    let clientFillerDone = false;   // Клиентский greeting отыграл
    let serverFillerDone = false;   // Серверный filler отыграл (первое сообщение)
    let greetingAudioCtx = null;    // 🛡️ AudioContext приветствия — для принудительной остановки
    let greetingSource = null;      // 🛡️ BufferSource приветствия — для принудительной остановки
    let greetingPlaying = false;    // 🛡️ Флаг: приветствие сейчас играет
    let greetingEl = null;          // 🔊 аудио-элемент приветствия (телефон)
    let greetingDone = null;        // ⏳ обещание: приветствие договорило
    let greetingDoneResolve = null;
    let greetingMs = 0;             // ⏱ длина записи приветствия, мс (узнаём у самой записи)
    let greetingStartedAt = 0;      // ⏱ когда приветствие пошло

    // ============================================================
    // Предзагрузка приветствия
    // ============================================================
    async function preloadGreeting(попыток) {
        // На мобильной сети первая закачка часто срывается. Раньше в этом
        // случае приветствие просто НЕ ЗВУЧАЛО: волны идут, а голоса нет.
        // Теперь пробуем несколько раз, а если всё равно пусто — докачаем
        // в момент нажатия (см. playGreeting).
        попыток = попыток || 3;
        for (let i = 1; i <= попыток; i++) {
            try {
                // Сначала из своего хранилища (быстро и без VPN),
                // не вышло — с сервера, как раньше.
                const адрес = (i === 1)
                    ? ASSETS + 'greeting-' + LANG + '.mp3'
                    : CONFIG.SERVER + '/api/greeting?lang=' + LANG;
                const resp = await fetch(адрес);
                if (resp.ok) {
                    cachedGreeting = await resp.arrayBuffer();
                    console.log('🤖 RT: Greeting preloaded', cachedGreeting.byteLength, 'bytes');
                    return true;
                }
            } catch (e) {
                console.warn('🤖 RT: Greeting preload failed (попытка ' + i + ')', e);
            }
            if (i < попыток) await new Promise(r => setTimeout(r, 1200));
        }
        return false;
    }

    // Воспроизведение приветствия (только один раз, с возможностью принудительной остановки)
    // ⏱ Страховка на случай, если приветствие застряло.
    // РАНЬШЕ здесь стояло глухое «жди 6 секунд и открывай микрофон». Приветствие
    // выросло до 7.1 сек (когда мы сбавили темп голоса) — и страховка стала
    // срабатывать КАЖДЫЙ раз: микрофон открывался на шестой секунде, Android
    // переключал звуковой тракт, и последнее слово проваливалось.
    // Теперь ждём столько, сколько длится сама запись, а выходим досрочно
    // только если приветствие вообще не зазвучало.
    function страховкаПриветствия() {
        return new Promise(resolve => {
            const начало = Date.now();
            (function проверить() {
                // приветствие так и не заиграло за 3 секунды — идти дальше
                if (!greetingPlaying && Date.now() - начало > 3000) return resolve();
                // длина записи известна — ждём её целиком плюс секунда запаса
                if (greetingMs && greetingStartedAt &&
                    Date.now() - greetingStartedAt > greetingMs + 1000) return resolve();
                // длину узнать не удалось — крайний срок, чтобы не висеть вечно
                if (Date.now() - начало > 20000) return resolve();
                setTimeout(проверить, 150);
            })();
        });
    }

    async function playGreeting() {
        if (clientFillerDone || greetingPlaying) return;

        // 🔊 Приветствия нет в памяти — значит закачка при открытии страницы
        // не удалась. Раньше здесь молча выходили, и человек слышал тишину.
        // Качаем прямо сейчас.
        if (!cachedGreeting) {
            console.log('🤖 RT: приветствия нет — качаю сейчас');
            if (typeof showToast === 'function') showToast('🤖 Загружаю голос…');
            await preloadGreeting(2);
            if (!cachedGreeting) {
                console.warn('🤖 RT: приветствие так и не скачалось');
                if (typeof showToast === 'function') showToast('🤖 Голос не загрузился, попробуй ещё раз');
                return;
            }
        }
        
        // 🛡️ Ставим замок ДО async операций — предотвращаем повторный вызов
        clientFillerDone = true;
        greetingPlaying = true;
        greetingDone = new Promise(res => { greetingDoneResolve = res; });
        
        // 🔊 На телефоне звук через WebAudio рвётся: пока грузится и
        // компилируется распознаватель речи, процессор занят и звуковой
        // конвейер не успевает — из фразы выпадают куски. Обычный
        // аудио-элемент проигрывает мимо главного потока и не рвётся.
        if (IS_MOBILE) {
            try {
                isBotSpeaking = true;
                const url = URL.createObjectURL(new Blob([cachedGreeting.slice(0)], { type: 'audio/mpeg' }));
                // Берём элемент, разбуженный касанием: новый браузер играть
                // не даст, а этому уже разрешено.
                const el = разрешённыйЭлемент || new Audio();
                разрешённыйЭлемент = null;
                el.src = url;
                el.preload = 'auto';
                greetingEl = el;
                // ⏱ Длину приветствия спрашиваем у самой записи, а не держим
                // в уме числом: поменяем текст или темп голоса — она подстроится.
                el.onloadedmetadata = () => {
                    if (isFinite(el.duration) && el.duration > 0) greetingMs = el.duration * 1000;
                };
                el.onended = el.onerror = () => {
                    isBotSpeaking = false;
                    greetingPlaying = false;
                    // 📱 ВАЖНО ДЛЯ ANDROID: аудио-элемент надо не просто забыть,
                    // а явно освободить. Пока он держит звуковой выход, система
                    // не отдаёт звуковой тракт микрофону — тот открывается, но
                    // отдаёт РОВНЫЕ НУЛИ, и первые слова уходят в пустоту.
                    try { el.pause(); } catch(e) {}
                    try { el.removeAttribute('src'); el.load(); } catch(e) {}
                    greetingEl = null;
                    try { URL.revokeObjectURL(url); } catch(e) {}
                    if (greetingDoneResolve) { greetingDoneResolve(); greetingDoneResolve = null; }
                };
                greetingStartedAt = Date.now();
                await el.play();
                if (isFinite(el.duration) && el.duration > 0) greetingMs = el.duration * 1000;
                addToChat('assistant', T.greetText);
                return;
            } catch (e) {
                console.warn('🎙 Greeting via <audio> failed, fallback to WebAudio', e);
                greetingEl = null;
                // падаем в обычный путь ниже
            }
        }

        try {
            isBotSpeaking = true;
            const ctx = new ACtx();
            greetingAudioCtx = ctx;  // 🛡️ Сохраняем для stop()
            
            if (ctx.state === 'suspended') await ctx.resume();
            
            // 🛡️ Проверяем что нас не выключили пока ждали resume
            if (!isActive) {
                greetingPlaying = false;
                isBotSpeaking = false;
                try { ctx.close(); } catch(e) {}
                greetingAudioCtx = null;
                return;
            }
            
            const buf = await ctx.decodeAudioData(cachedGreeting.slice(0));
            
            // 🛡️ Ещё раз проверяем — decodeAudioData тоже async
            if (!isActive) {
                greetingPlaying = false;
                isBotSpeaking = false;
                try { ctx.close(); } catch(e) {}
                greetingAudioCtx = null;
                return;
            }
            
            const src = ctx.createBufferSource();
            greetingSource = src;  // 🛡️ Сохраняем для stop()
            src.buffer = buf;
            src.connect(ctx.destination);
            src.onended = () => {
                isBotSpeaking = false;
                greetingPlaying = false;
                greetingSource = null;
                greetingAudioCtx = null;
                try { ctx.close(); } catch(e) {}
                if (greetingDoneResolve) { greetingDoneResolve(); greetingDoneResolve = null; }
            };
            greetingMs = buf.duration * 1000;
            greetingStartedAt = Date.now();
            src.start(0);
            addToChat('assistant', T.greetText);
        } catch (e) {
            isBotSpeaking = false;
            greetingPlaying = false;
            greetingSource = null;
            greetingAudioCtx = null;
            console.warn('🤖 RT: Greeting play error', e);
            if (greetingDoneResolve) { greetingDoneResolve(); greetingDoneResolve = null; }
        }
    }

    // ============================================================
    // VAD CDN загрузка
    // ============================================================
    function loadVAD() {
        return new Promise((resolve, reject) => {
            if (window.vad) { resolve(); return; }
            const s = document.createElement('script');
            s.src = ASSETS + 'bundle.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('VAD load failed'));
            document.head.appendChild(s);
        });
    }

    // ============================================================
    // WebSocket — подключение к voice-master протоколу
    // ============================================================
    function connectWS() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        
        // Синхронизация памяти с чатом — используем serverUid (точный uid от /api/identify)
        // _serverUid гарантирует совпадение с чатом; fallback на _quid если ещё не готов
        const uid = window._serverUid || window._quid || '';
        // язык страницы уходит в адрес — сервер сможет выбрать голос и распознавание
        let wsUrl = CONFIG.WS_URL + (uid ? '?uid=' + encodeURIComponent(uid) + '&lang=' + LANG : '?lang=' + LANG);
        if (OWNER_KEY) wsUrl += '&key=' + encodeURIComponent(OWNER_KEY);
        if (USER_TZ)   wsUrl += '&tz=' + encodeURIComponent(USER_TZ);
        
        console.log('🤖 RT: Connecting to', wsUrl, uid ? '(uid sync ✅)' : '(no uid)');
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'blob';  // 🔑 Voice-master шлёт бинарные аудио-фреймы

        ws.onopen = () => {
            console.log('🤖 RT: Connected');
            lastActivity = Date.now();
            
            // 🔒 ЖЕЛЕЗНЫЙ ЗАМОК ФИЛЛЕРА
            if (serverFillerDone) {
                // Reconnect — филлер уже играл, пропускаем на сервере
                ws.send(JSON.stringify({ type: 'skip_filler' }));
                console.log('🔒 RT: Filler skip (already played)');
            } else {
                // Первое подключение — филлер сейчас будет играть
                // Закрываем замок СРАЗУ, не дожидаясь audio_start
                serverFillerDone = true;
                console.log('🔒 RT: Filler lock set (first connect)');
            }
            
            // Пинг для поддержания соединения
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, CONFIG.PING_INTERVAL_MS);
            
            // 🔗 Синхронизация: отправляем историю текстового чата голосовому ИИ
            try {
                var chatMsgs = window.chatMessages || [];
                if (chatMsgs.length > 0) {
                    var history = chatMsgs.slice(-10).map(function(m) {
                        return { role: m.role || (m.type === 'user' ? 'user' : 'assistant'), content: m.content || m.text || '' };
                    }).filter(function(m) { return m.content && m.role; });
                    if (history.length > 0) {
                        ws.send(JSON.stringify({ type: 'chat_history', messages: history }));
                        console.log('🔗 RT: Chat history sent:', history.length, 'messages');
                    }
                }
            } catch(e) { console.warn('🔗 RT: Chat history sync error', e); }
            
            if (typeof showToast === 'function') showToast(T.connecting);
        };

        ws.onclose = (e) => {
            console.log('🤖 RT: Disconnected', e.code, e.reason);
            if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
            
            if (userInitiatedStop) {
                userInitiatedStop = false;
                return;
            }
            // Авто-реконнект только если активен
            if (isActive) {
                console.log('🤖 RT: Reconnecting in', CONFIG.RECONNECT_MS, 'ms');
                setTimeout(connectWS, CONFIG.RECONNECT_MS);
            }
        };

        ws.onerror = (e) => console.error('🤖 RT: WS error', e);
        ws.onmessage = onMessage;
    }

    // ============================================================
    // Обработка сообщений от voice-master сервера
    // ============================================================
    function onMessage(event) {
        lastActivity = Date.now();
        
        // 🔑 Бинарные данные = аудио (voice-master шлёт Blob/bytes)
        if (event.data instanceof Blob) {
            playChunk(event.data);
            return;
        }
        
        try {
            const d = JSON.parse(event.data);
            
            switch (d.type) {
                case 'stt_ready':
                    sttReady = true;
                    if (typeof showToast === 'function') showToast(T.ready);
                    break;
                    
                case 'transcript_interim':
                    // Промежуточный транскрипт — можно показать в UI
                    break;
                    
                case 'transcript_final':
                    if (d.content) addToChat('user', d.content);
                    startWaitNotice();       // ⏳ пошло ожидание ответа
                    break;
                    
                case 'response_text':
                    currentResponse += (currentResponse ? ' ' : '') + d.content;
                    break;
                    
                case 'audio_start':
                    stopWaitNotice();        // ⏳ ответ пошёл — ожидание снято
                    isBotSpeaking = true;
                    serverFillerDone = true;  // 🔒 Замок: любой звук = филлер больше не нужен
                    bargeInTriggered = false;
                    currentResponse = '';
                    break;
                    
                case 'audio_end':
                    isBotSpeaking = false;
                    serverFillerDone = true;  // 🔒 Серверный филлер отыграл
                    if (currentResponse) {
                        addToChat('assistant', currentResponse);
                        currentResponse = '';
                    }
                    break;
                    
                case 'status':
                    if (d.status === 'ready') {
                        // Сервер готов
                    } else if (d.status === 'reset') {
                        if (typeof showToast === 'function') showToast(T.reset);
                    }
                    break;
                    
                case 'error':
                    console.error('🤖 RT: Server error:', d.message);
                    if (typeof showToast === 'function') showToast('❌ ' + d.message);
                    break;
                    
                case 'pong':
                    // Ответ на ping — всё OK
                    break;
                    
                case 'metric_llm_start':
                case 'metric_tts_start':
                    // Метрики — игнорируем на клиенте
                    break;
            }
        } catch (e) {
            console.warn('🤖 RT: Parse error', e);
        }
    }

    // ============================================================
    // Добавление в чат платформы
    // ============================================================
    function addToChat(role, text) {
        if (!text || text === '...') return;
        // 🔗 Помечаем голосовые сообщения для синхронизации с чатботом
        var taggedText = '🎤 ' + text;
        // Используем глобальную функцию addMessage платформы
        if (typeof addMessage === 'function') {
            addMessage(role === 'user' ? 'user' : 'assistant', taggedText, true);
        }
    }

    // ============================================================
    // ЗАПУСК голосового режима
    // ============================================================
    async function start() {
        // 🛡️ Защита от двойного старта
        if (isActive || isStarting) {
            console.warn('🤖 RT: Already active or starting, ignoring');
            return;
        }
        isStarting = true;
        
        try {
            isActive = true;

            // 📱 ТЕЛЕФОН: микрофон открываем ПЕРВЫМ, до приветствия.
            // Открытие микрофона заставляет Android переключить звуковой тракт
            // с музыкального на разговорный, и на это уходит несколько секунд —
            // всё это время поток пустой (в дневнике «громкость 0 — ТИШИНА»).
            // Раньше переключение приходилось на начало разговора, и первые
            // слова человека уходили в мёртвый микрофон. Теперь оно проходит
            // в тишине, пока никто не говорит, а за семь секунд приветствия
            // микрофон успевает полностью проснуться.
            // Эхо не мешает: пока помощник говорит, звук на сервер не идёт
            // (см. isBotSpeaking в scriptProc), и приветствие не перебивается.
            if (IS_MOBILE) {
                сообщить('микрофон: открываю ДО приветствия');
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            sampleRate: 16000,
                            channelCount: 1
                        }
                    });
                    сообщить('микрофон: ОТКРЫТ до приветствия');
                } catch (e) {
                    // Не вышло — не беда, ниже попробуем обычным порядком
                    micStream = null;
                    сообщить('микрофон: не открылся заранее — ' + (e && e.name || '?'));
                }
                if (!isActive) { isStarting = false; return; }
            }

            // Мгновенно играем приветствие (кешированное)
            playGreeting();
            
            // Загружаем VAD
            await loadVAD();
            
            // Подключаем WebSocket
            connectWS();

            // 📱 ГЛАВНОЕ ДЛЯ ТЕЛЕФОНА: открытие микрофона заставляет Android
            // переключить звуковой тракт с «музыкального» на «разговорный»,
            // и в этот миг из записи выпадает кусок — отсюда проглоченные слова.
            // Поэтому приветствие договаривает ПОЛНОСТЬЮ, и только потом микрофон.
            // Загрузка распознавателя выше шла параллельно — она звука не трогает.
            if (IS_MOBILE && greetingDone) {
                if (typeof showToast === 'function') showToast(T.greetWait);
                await Promise.race([ greetingDone, страховкаПриветствия() ]);
                if (!isActive) { isStarting = false; return; }   // успели выключить
            }

            // 📱 Перед микрофоном звук должен быть отпущен ПОЛНОСТЬЮ.
            // Если приветствие оборвалось не через onended (ошибка, выключение),
            // элемент мог остаться живым — добиваем его здесь, и только потом
            // даём системе короткую передышку на переключение тракта.
            if (IS_MOBILE && !micStream) {
                if (greetingEl) {
                    try { greetingEl.pause(); } catch(e) {}
                    try { greetingEl.removeAttribute('src'); greetingEl.load(); } catch(e) {}
                    greetingEl = null;
                }
                if (currentEl) {
                    try { currentEl.pause(); } catch(e) {}
                    try { currentEl.removeAttribute('src'); currentEl.load(); } catch(e) {}
                    currentEl = null;
                }
                await new Promise(r => setTimeout(r, 400));
                if (!isActive) { isStarting = false; return; }
            }

            // 🎤 Микрофон мог быть открыт заранее (телефон) — тогда не трогаем
            if (!micStream) {
                сообщить('микрофон: открываю');
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 16000,
                        channelCount: 1
                    }
                });
                сообщить('микрофон: ОТКРЫТ');
            }

            // 📡 СНАЧАЛА ОТПРАВКА ЗВУКА, ПОТОМ распознаватель.
            // Silero тяжёлый: тянет из хранилища модель и движок на десятки
            // мегабайт и компилирует их — на телефоне это секунды, а через VPN
            // и того больше. Раньше он поднимался ПЕРВЫМ, и всё это время звук
            // на сервер не уходил вовсе: человек говорил в пустоту, первое
            // слово терялось. Теперь поток идёт к серверу сразу, Flux слышит
            // с первой секунды, а Silero подтягивается следом — он нужен
            // только для перебивания.
            // PCM streaming — отправляем аудио на сервер
            // iOS не даёт задать частоту принудительно — берём как выйдет,
            // ниже по коду есть пересчёт частоты, он всё выровняет
            try { audioCtx = new ACtx({ sampleRate: 16000 }); }
            catch (e) { audioCtx = new ACtx(); }
            if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) {} }
            const src = audioCtx.createMediaStreamSource(micStream);
            scriptProc = audioCtx.createScriptProcessor(4096, 1, 1);

            scriptProc.onaudioprocess = (e) => {
                if (!isActive || !ws || ws.readyState !== WebSocket.OPEN || isBotSpeaking) return;
                const inp = e.inputBuffer.getChannelData(0);
                if (!inp || !inp.length) return;
                
                // Ресемплинг если нужно
                const pcm = audioCtx.sampleRate !== 16000 ? resample(inp, audioCtx.sampleRate) : inp;
                
                // Конвертация в Int16 PCM
                const buf = new Int16Array(pcm.length);
                let сумма = 0;
                for (let i = 0; i < pcm.length; i++) {
                    const s = Math.max(-1, Math.min(1, pcm[i]));
                    buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    сумма += s * s;
                }
                ws.send(buf.buffer);

                // 🎤 САМОПРОВЕРКА МИКРОФОНА. Считаем громкость и раз в
                // несколько секунд сообщаем серверу — он пишет в дневник.
                // Так видно, слышит ли микрофон вообще: если всё время ноль,
                // значит звук не идёт, и молчание помощника не его вина.
                const громкость = Math.sqrt(сумма / pcm.length);
                if (громкость > микМакс) микМакс = громкость;
                const сейчас = Date.now();
                if (сейчас - микКогда > 4000) {
                    микКогда = сейчас;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'mic', level: +микМакс.toFixed(4) }));
                        } catch (e) {}
                    }
                    if (микМакс < 0.001) {
                        микТихо++;
                        if (микТихо === 3 && typeof showToast === 'function') {
                            showToast('🎤 Микрофон не слышит звука');
                        }
                    } else {
                        микТихо = 0;
                    }
                    микМакс = 0;
                }
            };

            src.connect(scriptProc);
            scriptProc.connect(audioCtx.destination);

            // Клонируем трек для VAD
            const track = micStream.getAudioTracks()[0].clone();
            vadStream = new MediaStream([track]);

            // Инициализация Silero VAD
            sileroVAD = await vad.MicVAD.new({
                stream: vadStream,
                onnxWASMBasePath: ASSETS,
                baseAssetPath: ASSETS,
                positiveSpeechThreshold: CONFIG.VAD_POSITIVE_THRESHOLD,
                negativeSpeechThreshold: CONFIG.VAD_NEGATIVE_THRESHOLD,
                redemptionFrames: CONFIG.VAD_REDEMPTION_FRAMES,
                minSpeechFrames: CONFIG.VAD_MIN_SPEECH_FRAMES,

                onSpeechStart: () => {
                    speechStart = Date.now();
                    if (speechTimer) clearTimeout(speechTimer);
                    // На телефоне динамик слышен микрофону: если верить первому же
                    // шороху, помощник перебивает сам себя и глотает слова.
                    // Поэтому пока он говорит — ждём заведомо человеческую речь.
                    var speakingNow = isBotSpeaking || isPlaying || audioQueue.length > 0;
                    // Пока помощник говорит, микрофон слышит его же голос из
                    // динамика — и на телефоне, и на компьютере. Поэтому порог
                    // перебивания поднят: случайный шорох ответ не оборвёт,
                    // а настоящая речь — оборвёт.
                    var wait = !speakingNow ? CONFIG.VAD_DEBOUNCE_MS
                             : (IS_MOBILE ? CONFIG.VAD_DEBOUNCE_MS_SPEAKING_MOBILE
                                          : CONFIG.VAD_DEBOUNCE_MS_SPEAKING_DESKTOP);
                    speechTimer = setTimeout(() => {
                        speechConfirmed = true;
                        lastActivity = Date.now();
                        // Barge-in если бот говорит
                        if (isBotSpeaking || isPlaying || audioQueue.length > 0) {
                            // приветствие не перебиваем никогда — оно короткое
                            if (greetingPlaying) return;
                            bargeIn();
                        }
                    }, wait);
                },

                onSpeechEnd: () => {
                    if (speechTimer) { clearTimeout(speechTimer); speechTimer = null; }
                    const dur = Date.now() - speechStart;
                    // РАНЬШЕ: если детектор не успел «подтвердить» речь
                    // (короткая фраза, или порог поднят пока помощник говорит),
                    // реплика ВЫБРАСЫВАЛАСЬ молча — отсюда «то слышит, то нет».
                    // Теперь отбрасываем только совсем короткие обрывки, а всё
                    // остальное отдаём серверу: пусть он решает по тексту.
                    if (dur < CONFIG.VAD_MIN_DURATION_MS) {
                        speechConfirmed = false;
                        return;
                    }
                    lastActivity = Date.now();
                    bargeInTriggered = false;
                    speechConfirmed = false;
                    // Отправляем speech_end серверу — voice-master протокол
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'speech_end' }));
                    }
                },

                onVADMisfire: () => {}
            });
            await sileroVAD.start();

            // Watchdog — при зависании реконнектим WS, НЕ перезапускаем start()
            // (перезапуск start() мог вызвать повторное приветствие)
            if (watchdog) clearInterval(watchdog);
            watchdog = setInterval(() => {
                if (!isActive) { clearInterval(watchdog); watchdog = null; return; }
                if (Date.now() - lastActivity > CONFIG.WATCHDOG_MS) {
                    console.warn('🤖 RT: Watchdog timeout, reconnecting WS...');
                    lastActivity = Date.now();  // 🛡️ Сброс чтобы не зациклиться
                    // Переподключаем только WebSocket, не весь модуль
                    if (ws) {
                        userInitiatedStop = true;  // Не триггерим авто-реконнект
                        try { ws.close(); } catch(e) {}
                        ws = null;
                    }
                    setTimeout(() => {
                        if (isActive) connectWS();
                    }, 1000);
                }
            }, 5000);

            console.log('🤖 RT: Started successfully');
            
        } catch (err) {
            isActive = false;
            console.error('🤖 RT: Start error', err);
            сообщить('микрофон: ОШИБКА ' + (err && (err.name || err.message) || '?'));
            var reason = '❌ ' + (err && err.message || T.unknown);
            if (err) {
                if (err.name === 'NotAllowedError')      reason = T.micDenied;
                else if (err.name === 'NotFoundError')   reason = T.micMissing;
                else if (err.name === 'NotReadableError') reason = T.micBusy;
                else if (String(err.message||'').indexOf('VAD') >= 0) reason = T.vadFail;
            }
            if (typeof showToast === 'function') showToast(reason);
            // Очищаем всё что успели создать
            cleanupResources();

            // 🔴 ГАСИМ ВОЛНЫ. Раньше при сорвавшемся запуске признак «включено»
            // сбрасывался внутри, а волны у имени оставались гореть. Человек
            // жал ещё раз — модуль считал, что выключено, и запускал заново.
            // Кнопка становилась «невыключаемой».
            isActive = false;
            try {
                var имя = document.getElementById('qname');
                if (имя) имя.classList.remove('active');
                var обёртка = document.querySelector('.qname-wrap');
                if (обёртка) обёртка.classList.remove('active');
            } catch (e) {}
        } finally {
            isStarting = false;
        }
    }

    // ============================================================
    // ОСТАНОВКА — полная очистка всех ресурсов
    // ============================================================
    function stop() {
        console.log('🤖 RT: Stopping...');
        isActive = false;
        isStarting = false;
        
        // serverFillerDone НЕ сбрасываем — при повторном включении приветствие не повторяется
        
        // 🛡️ ПРИНУДИТЕЛЬНАЯ ОСТАНОВКА ПРИВЕТСТВИЯ
        if (greetingEl) {
            try { greetingEl.pause(); greetingEl.src = ''; } catch(e) {}
            greetingEl = null;
        }
        if (greetingSource) {
            try { greetingSource.stop(0); } catch(e) {}
            greetingSource = null;
        }
        if (greetingAudioCtx) {
            try { greetingAudioCtx.close(); } catch(e) {}
            greetingAudioCtx = null;
        }
        greetingPlaying = false;
        
        // Таймеры
        if (speechTimer) { clearTimeout(speechTimer); speechTimer = null; }
        speechConfirmed = false;
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        
        // Состояние
        isBotSpeaking = false;
        sttReady = false;
        bargeInTriggered = false;
        currentResponse = '';
        
        // Останавливаем воспроизведение
        stopPlayback();
        
        // Закрываем WebSocket
        if (ws) {
            userInitiatedStop = true;
            try { ws.close(); } catch(e) {}
            ws = null;
        }
        
        // Очистка ресурсов
        cleanupResources();
        
        console.log('🤖 RT: Stopped');
    }
    
    function cleanupResources() {
        // VAD
        if (sileroVAD) {
            try { sileroVAD.pause(); } catch(e) {}
            try { sileroVAD.destroy(); } catch(e) {}
            sileroVAD = null;
        }
        
        // VAD stream
        if (vadStream) {
            vadStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
            vadStream = null;
        }
        
        // Script processor
        if (scriptProc) {
            try { scriptProc.disconnect(); } catch(e) {}
            scriptProc = null;
        }
        
        // Микрофон
        if (micStream) {
            micStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
            micStream = null;
        }
        
        // AudioContext
        if (audioCtx && audioCtx.state !== 'closed') {
            try { audioCtx.close(); } catch(e) {}
            audioCtx = null;
        }
    }

    // ============================================================
    // Audio playback — воспроизведение ответов от сервера
    // ============================================================
    function playChunk(blob) {
        if (bargeInTriggered) return;
        audioQueue.push(blob);
        if (!isPlaying) playNext();
    }

    async function playNext() {
        if (bargeInTriggered) { audioQueue = []; isPlaying = false; currentAudio = null; return; }
        if (!audioQueue.length) { isPlaying = false; currentAudio = null; return; }
        
        isPlaying = true;
        const blob = audioQueue.shift();
        
        // 🔊 Телефон: ответы тоже играем аудио-элементом — не рвутся при нагрузке
        if (IS_MOBILE) {
            try {
                const url = URL.createObjectURL(blob);
                const el = new Audio(url);
                currentEl = el;
                const finish = () => {
                    if (currentEl === el) currentEl = null;
                    try { URL.revokeObjectURL(url); } catch(e) {}
                    playNext();
                };
                el.onended = finish;
                el.onerror = finish;
                await el.play();
                return;
            } catch (e) {
                console.warn('🎙 Chunk via <audio> failed, fallback to WebAudio', e);
                currentEl = null;
                // падаем в обычный путь ниже
            }
        }

        try {
            const ctx = new ACtx();
            if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
            currentAudio = ctx;
            const gain = ctx.createGain();
            gain.gain.value = 1.0;
            currentAudio.gainNode = gain;
            
            const ab = await blob.arrayBuffer();
            const buf = await ctx.decodeAudioData(ab);
            const s = ctx.createBufferSource();
            s.buffer = buf;
            s.connect(gain);
            gain.connect(ctx.destination);
            
            s.onended = () => {
                if (currentAudio === ctx) currentAudio = null;
                try { ctx.close(); } catch(e) {}
                playNext();
            };
            s.start(0);
        } catch (e) {
            console.warn('🤖 RT: Playback error', e);
            currentAudio = null;
            playNext();
        }
    }

    function stopPlayback() {
        audioQueue = [];
        isPlaying = false;
        if (currentEl) {
            try { currentEl.pause(); currentEl.onended = null; currentEl.src = ''; } catch(e) {}
            currentEl = null;
        }
        if (currentAudio) {
            try {
                const c = currentAudio;
                if (c.gainNode) {
                    c.gainNode.gain.setValueAtTime(1, c.currentTime);
                    c.gainNode.gain.linearRampToValueAtTime(0, c.currentTime + 0.05);
                }
                setTimeout(() => {
                    try { c.suspend(); c.close(); } catch(e) {}
                }, 50);
            } catch(e) {}
            currentAudio = null;
        }
    }

    // ============================================================
    // Barge-in — прерывание бота
    // ============================================================
    function bargeIn() {
        bargeInTriggered = true;
        stopPlayback();
        isBotSpeaking = false;
        isPlaying = false;
        // Отправляем barge_in серверу — voice-master протокол
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'barge_in' }));
        }
    }

    // ============================================================
    // Ресемплинг
    // ============================================================
    function resample(data, from) {
        const r = from / 16000;
        const len = Math.round(data.length / r);
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            const idx = i * r;
            const f = Math.floor(idx);
            const c = Math.min(f + 1, data.length - 1);
            const t = idx - f;
            out[i] = data[f] * (1 - t) + data[c] * t;
        }
        return out;
    }

    // ============================================================
    // Toggle — вызывается кнопкой 🤖
    // ============================================================
    function toggle() {
        const wrapper = document.getElementById('qname');   // индикатор = имя QUANTAREON на сайте
        
        if (isActive) {
            // ВЫКЛЮЧАЕМ
            stop();
            if (wrapper) wrapper.classList.remove('active');
            if (typeof showToast === 'function') showToast(T.stopped);
        } else {
            // ВКЛЮЧАЕМ (с защитой от двойного старта)
            if (isStarting) {
                console.warn('🤖 RT: Already starting, ignoring');
                return;
            }
            unlockAudio();   // 🔓 обязательно синхронно, внутри касания
            if (wrapper) wrapper.classList.add('active');
            if (typeof showToast === 'function') showToast(T.starting);
            start();
        }
    }

    // 🔒 Сброс филлеров (при новом чате / сбросе сессии)
    function resetFillers() {
        clientFillerDone = false;
        serverFillerDone = false;  // Новая сессия = новое приветствие
    }
    
    // Сброс контекста на сервере
    function resetContext() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'reset' }));
        }
        resetFillers();
    }

    // ============================================================
    // Глобальный API
    // ============================================================
    window.QuantarionRealtime = {
        toggle,
        isActive: () => isActive,
        stop,
        resetFillers,
        resetContext
    };
    
    // Глобальная функция для кнопки в HTML
    window.toggleRealtime = toggle;
    window.QuantareonVoice = window.QuantarionRealtime;
    
    console.log('🎙 QUANTAREON Voice loaded → ' + CONFIG.WS_URL);
    
    // Предзагружаем приветствие
    preloadGreeting();
})();
