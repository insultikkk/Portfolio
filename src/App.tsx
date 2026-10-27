import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Asterisk,
  AudioLines,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  Globe2,
  Keyboard,
  Layers2,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MousePointer2,
  Music2,
  PanelRight,
  Pause,
  Radio,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { command, native, openLink, saveSettings, subscribe } from "./bridge";
import { formatTime, positionAt } from "./core/sync";
import { initialState, type Settings, type ViewState } from "./core/types";
import { LyricsCard } from "./components/LyricsCard";
import { demoDocument, demoPlayback } from "./demo";
import "./styles.css";

type Tab = "overview" | "appearance" | "connection" | "ai";
export default function App() {
  const [state, setState] = useState<ViewState>(initialState);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [showExample, setShowExample] = useState(!native);
  const [now, setNow] = useState(Date.now());
  const overlay =
    new URLSearchParams(location.search).get("window") === "overlay";
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let alive = true;
    subscribe((s) => {
      if (alive) setState(s);
    })
      .then((fn) => {
        if (alive) dispose = fn;
        else fn();
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.window = overlay ? "overlay" : "settings";
  }, [overlay]);
  async function act(action: () => Promise<unknown>) {
    try {
      setError("");
      await action();
    } catch (e) {
      setError(String(e));
    }
  }
  async function update(patch: Partial<Settings>) {
    await act(() => saveSettings({ ...state.settings, ...patch }));
  }
  async function getToken() {
    await act(async () => {
      setToken(await command<string>("pairing_token"));
    });
  }
  const previewState = showExample
    ? {
        ...state,
        playback: demoPlayback(),
        lyrics: demoDocument(),
        lyricsStatus: "ready" as const,
      }
    : state;
  const position = state.playback ? positionAt(state.playback, now) : 0;
  const sourceStatus =
    state.lyricsStatus === "ready"
      ? "Текст найден"
      : state.lyricsStatus === "loading"
        ? "Ищем текст…"
        : state.lyricsStatus === "offline"
          ? "Нет доступа к LRCLIB"
          : state.lyricsStatus === "ambiguous"
            ? "Нужно выбрать запись"
            : state.lyricsStatus === "missing"
              ? "Текст не найден"
              : "Готов к поиску";
  if (overlay) return <LyricsCard state={state} demo={!native} />;
  const aiBusy = ["downloading"].includes(state.ai.status);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("overview");
          }}
          aria-label="Still — обзор"
        >
          <span className="brand-symbol">
            <AudioLines size={24} />
          </span>
          <span>
            still<span className="brand-dot">.</span>
            <small>LIVE LYRICS</small>
          </span>
        </a>
        <div className="nav-label">ВАШЕ ПРОСТРАНСТВО</div>
        <nav>
          {(
            [
              { id: "overview", icon: Layers2, label: "Обзор" },
              { id: "appearance", icon: PanelRight, label: "Оверлей" },
              { id: "connection", icon: Link2, label: "Подключение" },
              { id: "ai", icon: Sparkles, label: "Локальный ИИ" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "selected" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={17} />
              {item.label}
              {item.id === "ai" && <span className="mini-tag">LOCAL</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="small-orbit">
            <Music2 size={17} />
          </span>
          <p>
            Ваша музыка.
            <br />
            Ваш ритм.
          </p>
          <span>А слова всегда рядом.</span>
        </div>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          Работает на компьютере
          <small>
            STILL FOR WINDOWS <span>v0.1.0</span>
          </small>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumbs">
            Пространство <ChevronRight size={12} />
            <span>
              {
                {
                  overview: "Обзор",
                  appearance: "Оверлей",
                  connection: "Подключение",
                  ai: "Локальный ИИ",
                }[tab]
              }
            </span>
          </div>
          <button
            className="help-button"
            title="Как пользоваться"
            onClick={() => setTab("connection")}
          >
            <CircleHelp size={16} />
            <span>Как это работает</span>
          </button>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                МУЗЫКА В ВАШЕМ ПОТОКЕ
              </div>
              <h1>
                {tab === "overview" ? (
                  <>
                    Занимайтесь своим.
                    <br />
                    <span>Пойте любимое.</span>
                  </>
                ) : tab === "appearance" ? (
                  <>
                    Маленькое окно.
                    <br />
                    <span>Ваше настроение.</span>
                  </>
                ) : tab === "connection" ? (
                  <>
                    Один раз подключить.
                    <br />
                    <span>Дальше — музыка.</span>
                  </>
                ) : (
                  <>
                    Слова найдутся.
                    <br />
                    <span>Даже без таймингов.</span>
                  </>
                )}
              </h1>
              <p className="intro">
                {tab === "overview"
                  ? "Любимые строки поверх приложений. Ничего лишнего между вами и музыкой."
                  : tab === "appearance"
                    ? "Настройте карточку так, чтобы она стала частью вашего рабочего пространства."
                    : tab === "connection"
                      ? "SoundCloud играет в браузере. Still держит слова рядом с вами."
                      : "Локальное распознавание для редких записей, ремиксов и новых открытий."}
              </p>
            </div>
            <span
              className={`connection-pill ${state.connected ? "online" : ""}`}
            >
              <i />
              {!native
                ? "Демо интерфейса"
                : state.connected
                  ? "Браузер подключён"
                  : "Ожидаем браузер"}
            </span>
          </div>
          {!native && (
            <div className="preview-notice">
              <Monitor size={13} />
              <span>
                Демонстрация интерфейса · поверх приложений работает
                Windows-версия.
              </span>
            </div>
          )}
          {(error || state.error) && (
            <div className="error-banner" role="alert">
              {error || state.error}
              <button
                aria-label="Закрыть уведомление"
                onClick={() => {
                  setError("");
                  setState((s) => ({ ...s, error: null }));
                }}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {(tab === "overview" || tab === "appearance") && (
            <>
              <div className="section-heading">
                <h2>
                  Ваш оверлей <span>ПРЕДПРОСМОТР</span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => setShowExample((v) => !v)}
                >
                  {showExample ? (
                    <CheckCheck size={13} />
                  ) : (
                    <Music2 size={13} />
                  )}{" "}
                  {showExample ? "Показать текущую песню" : "Посмотреть пример"}
                </button>
              </div>
              <div className="workspace-scene">
                <div className="scene-grain" />
                <div className="workspace-window">
                  <div className="window-chrome">
                    <i />
                    <i />
                    <i />
                    <span>Моё пространство</span>
                    <span className="chrome-plus">+</span>
                  </div>
                  <div className="fake-editor">
                    <span className="doc-emoji" aria-hidden="true">
                      <Asterisk size={28} />
                    </span>
                    <span className="editor-label">
                      ПОНЕДЕЛЬНИК · НОВЫЕ ИДЕИ
                    </span>
                    <h3>
                      Хороший день,
                      <br />
                      чтобы создавать.
                    </h3>
                    <p>
                      Немного фокуса. Немного вдохновения.
                      <br />И правильная музыка на фоне.
                    </p>
                    <div className="fake-line long" />
                    <div className="fake-line" />
                    <div className="fake-line short" />
                    <div className="editor-check">
                      <Check size={11} />
                      <span>Оставить место для вдохновения</span>
                    </div>
                  </div>
                  <span className="scene-caret" />
                </div>
                <div className="scene-card">
                  <LyricsCard state={previewState} preview demo={showExample} />
                </div>
                <div className="scene-caption">
                  <span>
                    <i />
                    Поверх вашего рабочего пространства
                  </span>
                  <span>
                    <LockKeyhole size={11} />
                    Фокус остаётся у вас
                  </span>
                </div>
              </div>
              <div className="playback-strip">
                <div className="source-icon">
                  <AudioLines size={20} />
                </div>
                <div className="playback-info">
                  <span>
                    {!native
                      ? "ПРИМЕР · ОРИГИНАЛЬНЫЙ ДЕМО-ТЕКСТ"
                      : state.playback
                        ? "СЕЙЧАС В SOUNDCLOUD"
                        : "ВАШ ПЛЕЕР"}
                  </span>
                  <strong>
                    {state.playback
                      ? `${state.playback.track.title}${state.playback.track.artist ? " — " + state.playback.track.artist : ""}`
                      : "Подключите браузер, чтобы увидеть песню"}
                  </strong>
                </div>
                <div className="song-timeline">
                  <div>
                    <i
                      style={{
                        width: `${state.playback ? (position / state.playback.track.durationMs) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span>
                    {formatTime(position)}{" "}
                    <span>
                      / {formatTime(state.playback?.track.durationMs || 0)}
                    </span>
                  </span>
                </div>
                <button
                  className="icon-button"
                  title={
                    state.connected
                      ? "Открыть SoundCloud"
                      : "Подключить SoundCloud"
                  }
                  onClick={() =>
                    state.connected && state.playback
                      ? act(() => openLink(state.playback!.track.id))
                      : setTab("connection")
                  }
                >
                  <ExternalLink size={16} />
                </button>
              </div>
              <div className="control-grid">
                <section className="control-card">
                  <div className="control-title">
                    <span className="control-icon">
                      <Settings2 size={17} />
                    </span>
                    <h2>Как вам удобно</h2>
                  </div>
                  <div className="setting-row">
                    <span>
                      <MousePointer2 size={15} />
                      Пропускать клики
                    </span>
                    <button
                      role="switch"
                      aria-checked={state.settings.locked}
                      aria-label="Пропускать клики"
                      className={`switch ${state.settings.locked ? "on" : ""}`}
                      onClick={() => update({ locked: !state.settings.locked })}
                    >
                      <i />
                    </button>
                  </div>
                  <div className="setting-row">
                    <span>
                      <Layers2 size={15} />
                      Показывать оверлей
                    </span>
                    <button
                      role="switch"
                      aria-checked={state.settings.visible}
                      aria-label="Показывать оверлей"
                      className={`switch ${state.settings.visible ? "on" : ""}`}
                      onClick={() =>
                        update({ visible: !state.settings.visible })
                      }
                    >
                      <i />
                    </button>
                  </div>
                  <label className="range-label" htmlFor="opacity">
                    Непрозрачность{" "}
                    <span>{Math.round(state.settings.opacity * 100)}%</span>
                  </label>
                  <input
                    id="opacity"
                    aria-label="Непрозрачность"
                    className="range"
                    type="range"
                    min="30"
                    max="100"
                    value={Math.round(state.settings.opacity * 100)}
                    onChange={(e) =>
                      update({ opacity: Number(e.target.value) / 100 })
                    }
                  />
                  {tab === "appearance" && (
                    <>
                      <label className="range-label" htmlFor="font">
                        Размер текста{" "}
                        <span>
                          {Math.round(state.settings.fontScale * 100)}%
                        </span>
                      </label>
                      <input
                        id="font"
                        className="range"
                        type="range"
                        min="75"
                        max="150"
                        value={Math.round(state.settings.fontScale * 100)}
                        onChange={(e) =>
                          update({ fontScale: Number(e.target.value) / 100 })
                        }
                      />
                      <label className="range-label" htmlFor="width">
                        Ширина окна <span>{state.settings.width}px</span>
                      </label>
                      <input
                        id="width"
                        className="range"
                        type="range"
                        min="280"
                        max="720"
                        step="10"
                        value={state.settings.width}
                        onChange={(e) =>
                          update({ width: Number(e.target.value) })
                        }
                      />
                      <label className="range-label" htmlFor="height">
                        Высота окна <span>{state.settings.height}px</span>
                      </label>
                      <input
                        id="height"
                        className="range"
                        type="range"
                        min="240"
                        max="900"
                        step="10"
                        value={state.settings.height}
                        onChange={(e) =>
                          update({ height: Number(e.target.value) })
                        }
                      />
                    </>
                  )}
                </section>
                <section className="control-card lyrics-source">
                  <div className="control-title">
                    <span className="control-icon">
                      <AudioLines size={17} />
                    </span>
                    <h2>Слова в нужный момент</h2>
                    <span className="subtle-tag">AUTO</span>
                  </div>
                  <div className="source-row">
                    <span className="provider-logo">
                      lrc<span>lib</span>
                    </span>
                    <div>
                      <strong>
                        {!native ? "Построчно и по словам" : sourceStatus}
                      </strong>
                      <p>Готовые тексты и временные метки</p>
                    </div>
                    <i className="status-light" />
                  </div>
                  <div className="ai-inline">
                    <Sparkles size={15} />
                    <p>
                      Нет готового текста?
                      <br />
                      <span>Распознаем локально, на компьютере.</span>
                    </p>
                    <button
                      className="icon-button"
                      title="Локальное распознавание"
                      onClick={() => setTab("ai")}
                    >
                      <ArrowRight size={16} />
                    </button>
                  </div>
                  <div className="source-footer">
                    <ShieldCheck size={12} />
                    Звук остаётся на вашем устройстве
                  </div>
                </section>
              </div>
              {tab === "appearance" && (
                <section className="timing-card">
                  <div>
                    <h2>Поправка синхронизации</h2>
                    <p>Если текст опережает вокал или слегка отстаёт.</p>
                  </div>
                  <div className="timing-controls">
                    <button
                      onClick={() =>
                        update({
                          offsetMs: Math.max(
                            -10000,
                            state.settings.offsetMs - 100,
                          ),
                        })
                      }
                    >
                      −
                    </button>
                    <output>
                      {state.settings.offsetMs > 0 ? "+" : ""}
                      {state.settings.offsetMs} мс
                    </output>
                    <button
                      onClick={() =>
                        update({
                          offsetMs: Math.min(
                            10000,
                            state.settings.offsetMs + 100,
                          ),
                        })
                      }
                    >
                      +
                    </button>
                    <button
                      title="Сбросить задержку"
                      onClick={() => update({ offsetMs: 0 })}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                </section>
              )}
              <div className="shortcut-strip">
                <Keyboard size={16} />
                <span>Всегда под рукой</span>
                <span>
                  <kbd>Ctrl</kbd>
                  <kbd>Alt</kbd>
                  <kbd>L</kbd> <small>показать / скрыть</small>
                </span>
                <span>
                  <kbd>Ctrl</kbd>
                  <kbd>Alt</kbd>
                  <kbd>E</kbd> <small>переместить / закрепить</small>
                </span>
              </div>
            </>
          )}
          {tab === "connection" && (
            <div className="connection-layout">
              <section className="setup-card">
                <div className="step-number">01</div>
                <h2>Расширение для вашего браузера</h2>
                <p>
                  В комплекте со Still есть папка расширения. В Chrome или Edge
                  откройте страницу расширений, включите режим разработчика и
                  нажмите «Загрузить распакованное расширение». Выберите папку
                  <code> extension</code> из комплекта.
                </p>
                <div className="browser-pills">
                  <span>
                    <Globe2 size={16} />
                    Chrome 116+
                  </span>
                  <span>
                    <Globe2 size={16} />
                    Microsoft Edge
                  </span>
                </div>
                <div className="step-number">02</div>
                <h2>Свяжите расширение со Still</h2>
                <p>
                  Скопируйте токен ниже в окно расширения. Он даёт доступ только
                  к приложению на этом компьютере.
                </p>
                <div className="token-field">
                  <input
                    aria-label="Токен сопряжения"
                    type="password"
                    value={token}
                    readOnly
                    placeholder="Токен хранится только на компьютере"
                  />
                  <button
                    className="icon-button"
                    title="Показать токен"
                    onClick={getToken}
                  >
                    <Link2 size={15} />
                  </button>
                  <button
                    className="icon-button"
                    title="Копировать токен"
                    onClick={() =>
                      act(async () => {
                        const t =
                          token || (await command<string>("pairing_token"));
                        setToken(t);
                        await navigator.clipboard.writeText(t);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      })
                    }
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
                <button
                  className="text-button muted"
                  onClick={() =>
                    act(async () =>
                      setToken(await command<string>("rotate_token")),
                    )
                  }
                >
                  <RotateCcw size={12} />
                  Сбросить подключение
                </button>
                <div className="step-number">03</div>
                <h2>Включите свою музыку</h2>
                <p>
                  Обновите вкладку SoundCloud после установки расширения.
                  Включите песню — Still найдёт текст и подстроится под
                  воспроизведение.
                </p>
                <button
                  className="primary-button"
                  onClick={() => act(() => openLink("https://soundcloud.com/"))}
                >
                  Открыть SoundCloud
                  <ExternalLink size={14} />
                </button>
              </section>
              <aside className="info-card">
                <span className="large-icon">
                  <Link2 size={25} />
                </span>
                <h3>Каждому — своя роль</h3>
                <p>
                  SoundCloud сообщает, что играет. LRCLIB находит слова и
                  тайминги. Still держит их рядом.
                </p>
                <div className="info-separator" />
                <ShieldCheck size={18} />
                <h4>Без музыкальных паролей</h4>
                <p>
                  Расширение не передаёт cookies и не просит пароль от
                  SoundCloud.
                </p>
                <small>Spotify и Яндекс Музыка — следующие подключения.</small>
              </aside>
            </div>
          )}
          {tab === "ai" && (
            <div className="connection-layout">
              <section className="setup-card">
                <span className="feature-icon">
                  <Sparkles size={28} />
                </span>
                <h2 className="feature-title">Когда песня — редкая находка</h2>
                <p>
                  Для ремикса может не быть готового текста. Whisper слушает
                  выбранную вкладку и распознаёт вокал на вашем компьютере.
                </p>
                <div className="ai-facts">
                  <span>
                    <ShieldCheck size={16} />
                    Без отправки аудио
                  </span>
                  <span>
                    <Volume2 size={16} />
                    Только выбранная вкладка
                  </span>
                </div>
                <div className="model-card">
                  <div>
                    <strong>Whisper Small · Q5_1</strong>
                    <span>Многоязычная модель · CPU</span>
                  </div>
                  <span className="subtle-tag">LOCAL</span>
                </div>
                <p className="model-description">
                  Первая загрузка — около 466 МБ. После проверки файл квантуется
                  локально. Модель не входит в установщик.
                </p>
                {aiBusy && (
                  <div className="download-progress">
                    <i style={{ width: `${state.ai.progress * 100}%` }} />
                  </div>
                )}
                <button
                  className="primary-button"
                  disabled={
                    aiBusy ||
                    ["ready", "listening", "processing"].includes(
                      state.ai.status,
                    )
                  }
                  onClick={() => act(() => command("download_model"))}
                >
                  {aiBusy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )}{" "}
                  {aiBusy
                    ? `Подготовка модели · ${Math.round(state.ai.progress * 100)}%`
                    : ["ready", "listening", "processing"].includes(
                          state.ai.status,
                        )
                      ? "Модель готова"
                      : "Подготовить локальную модель"}
                </button>
                <p className="model-status" role="status">
                  {state.ai.message ||
                    "После загрузки нажмите «Распознавать эту вкладку» в расширении."}
                </p>
                {["listening", "processing"].includes(state.ai.status) && (
                  <p className="model-status">
                    {state.ai.status === "processing"
                      ? "Распознаём фрагмент"
                      : "Слушаем выбранную вкладку"}{" "}
                    · отставание {Math.round(state.ai.lagMs / 1000)} с
                  </p>
                )}
                {["listening", "processing"].includes(state.ai.status) && (
                  <button
                    className="secondary-button"
                    onClick={() => act(() => command("stop_capture"))}
                  >
                    <Pause size={14} />
                    Остановить распознавание
                  </button>
                )}
                <div className="notice-box">
                  <Radio size={18} />
                  <div>
                    <strong>В первый раз — с задержкой</strong>
                    <p>
                      ИИ распознаёт уже прозвучавший вокал. При повторе
                      используем сохранённые тайминги. Ошибки возможны;
                      записанные участки отмечаются отдельно.
                    </p>
                  </div>
                </div>
              </section>
              <aside className="info-card">
                <span className="large-icon">
                  <AudioLines size={25} />
                </span>
                <h3>Готовый текст всегда первым</h3>
                <p>
                  Сначала Still проверяет кэш и LRCLIB. Распознавание включается
                  вами отдельно.
                </p>
                <div className="info-separator" />
                <h4>Не мешает вашему потоку</h4>
                <p>
                  Обработка идёт в отдельном процессе с ограниченным числом
                  потоков. При перегрузке очередь не растёт бесконечно.
                </p>
                <small>
                  Тайминги ИИ приблизительные. Звук не сохраняется на диск.
                </small>
              </aside>
            </div>
          )}
          {state.candidates.length > 0 && (
            <section className="candidate-panel">
              <div className="section-heading">
                <h2>Какая запись сейчас играет?</h2>
                <button
                  className="text-button"
                  onClick={() => act(() => command("retry_lyrics"))}
                >
                  <RotateCcw size={12} />
                  Обновить
                </button>
              </div>
              {state.candidates.map((c) => (
                <button
                  key={c.id}
                  className="candidate"
                  onClick={() =>
                    act(() =>
                      command("choose_lyrics", {
                        id: c.id,
                        trackKey:
                          state.lyrics?.trackKey ||
                          (state.playback
                            ? `${state.playback.track.source}:${state.playback.track.id}:${Math.round(state.playback.track.durationMs)}`
                            : ""),
                      }),
                    )
                  }
                >
                  <Music2 size={16} />
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.artist} · {formatTime(c.durationMs)}
                      {!c.compatible ? " · Другая версия или длительность" : ""}
                    </small>
                  </span>
                  <span>{c.synced ? "С таймингами" : "Только текст"}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </section>
          )}
          {state.playback && native && (
            <div className="genius-link">
              <button
                className="text-button"
                onClick={() =>
                  act(() =>
                    openLink(
                      `https://genius.com/search?q=${encodeURIComponent(`${state.playback!.track.artist} ${state.playback!.track.title}`)}`,
                    ),
                  )
                }
              >
                Найти текст на Genius
                <ExternalLink size={11} />
              </button>
              {["offline", "missing"].includes(state.lyricsStatus) && (
                <button
                  className="text-button"
                  onClick={() => act(() => command("retry_lyrics"))}
                >
                  <RotateCcw size={12} />
                  Повторить поиск
                </button>
              )}
            </div>
          )}
          <footer className="page-footer">
            <span>
              <i />
              Маленькое окно. Большое настроение.
            </span>
            <span>
              Сделано для вашего фокуса
              <Asterisk className="footer-spark" size={18} aria-hidden="true" />
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
