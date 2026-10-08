import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SCRIPT_SELECTOR =
  'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

type TurnstileWidgetId = string;

type TurnstileRenderOptions = {
  sitekey: string;
  action?: string;
  cData?: string;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "compact" | "flexible";
  language?: string;
  tabindex?: number;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": (errorCode?: string) => void;
};

type TurnstileApi = {
  render: (
    container: HTMLElement | string,
    options: TurnstileRenderOptions,
  ) => TurnstileWidgetId;
  reset: (widgetId?: TurnstileWidgetId) => void;
  remove: (widgetId?: TurnstileWidgetId) => void;
  getResponse: (widgetId?: TurnstileWidgetId) => string | undefined;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Turnstile requires a browser environment."));
  }

  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;

  const pendingPromise = new Promise<TurnstileApi>((resolve, reject) => {
    let settled = false;
    let pollTimer: number | undefined;
    let timeoutTimer: number | undefined;
    let script = document.querySelector<HTMLScriptElement>(
      TURNSTILE_SCRIPT_SELECTOR,
    );
    const shouldAppendScript = !script;

    const cleanup = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);
    };

    const finish = (api: TurnstileApi) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(api);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function handleLoad() {
      if (window.turnstile) finish(window.turnstile);
    }

    function handleError() {
      if (script?.dataset.nodemailTurnstile === "true") script.remove();
      fail(new Error("Unable to load the Cloudflare Turnstile script."));
    }

    if (!script) {
      script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.dataset.nodemailTurnstile = "true";
    }

    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    if (shouldAppendScript) document.head.appendChild(script);

    pollTimer = window.setInterval(() => {
      if (window.turnstile) finish(window.turnstile);
    }, 25);

    timeoutTimer = window.setTimeout(() => {
      if (script?.dataset.nodemailTurnstile === "true") script.remove();
      fail(new Error("Timed out while loading Cloudflare Turnstile."));
    }, SCRIPT_LOAD_TIMEOUT_MS);
  });

  turnstileScriptPromise = pendingPromise.catch((error: unknown) => {
    turnstileScriptPromise = null;
    throw error;
  });

  return turnstileScriptPromise;
}

export type TurnstileWidgetHandle = {
  reset: () => void;
  remove: () => void;
  getResponse: () => string | null;
};

export type TurnstileWidgetProps = {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (errorCode?: string) => void;
  resetKey?: string | number;
  action?: string;
  cData?: string;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "compact" | "flexible";
  responsive?: boolean;
  language?: string;
  tabIndex?: number;
  className?: string;
  id?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

const TurnstileWidget = forwardRef<
  TurnstileWidgetHandle,
  TurnstileWidgetProps
>(function TurnstileWidget(
  {
    siteKey,
    onVerify,
    onExpire,
    onError,
    resetKey,
    action,
    cData,
    theme = "auto",
    size = "normal",
    responsive = false,
    language = "auto",
    tabIndex = 0,
    className,
    id,
    style,
    ariaLabel = "Human verification",
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null);
  const callbacksRef = useRef({ onVerify, onExpire, onError });
  const [responsiveSize, setResponsiveSize] = useState<
    "normal" | "compact" | null
  >(null);
  const renderSize = responsive ? responsiveSize : size;

  callbacksRef.current = { onVerify, onExpire, onError };

  useEffect(() => {
    if (!responsive) {
      setResponsiveSize(null);
      return undefined;
    }

    const container = containerRef.current;
    if (!container) return undefined;

    setResponsiveSize(null);
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === container);
      const nextSize =
        (entry?.contentRect.width ?? container.getBoundingClientRect().width) <
        300
          ? "compact"
          : "normal";
      setResponsiveSize((currentSize) =>
        currentSize === nextSize ? currentSize : nextSize,
      );
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [responsive]);

  const removeWidget = () => {
    const api = apiRef.current;
    const widgetId = widgetIdRef.current;
    widgetIdRef.current = null;
    if (!api || !widgetId) return;
    try {
      api.remove(widgetId);
    } catch {
      // The widget may already have been removed by a navigation or DOM teardown.
    }
  };

  useImperativeHandle(
    forwardedRef,
    () => ({
      reset() {
        const api = apiRef.current;
        const widgetId = widgetIdRef.current;
        if (api && widgetId) api.reset(widgetId);
      },
      remove: removeWidget,
      getResponse() {
        const api = apiRef.current;
        const widgetId = widgetIdRef.current;
        if (!api || !widgetId) return null;
        return api.getResponse(widgetId) || null;
      },
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    if (!siteKey.trim()) {
      callbacksRef.current.onError?.("missing-site-key");
      return undefined;
    }
    if (!renderSize) return undefined;

    void loadTurnstileScript()
      .then((api) => {
        if (cancelled || !containerRef.current) return;

        apiRef.current = api;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          action,
          cData,
          theme,
          size: renderSize,
          language,
          tabindex: tabIndex,
          callback: (token) => callbacksRef.current.onVerify(token),
          "expired-callback": () => callbacksRef.current.onExpire?.(),
          "error-callback": (errorCode) =>
            callbacksRef.current.onError?.(errorCode),
        });
      })
      .catch(() => {
        if (!cancelled) callbacksRef.current.onError?.("script-load-error");
      });

    return () => {
      cancelled = true;
      removeWidget();
    };
  }, [siteKey, action, cData, theme, renderSize, language, tabIndex]);

  useEffect(() => {
    const api = apiRef.current;
    const widgetId = widgetIdRef.current;
    if (api && widgetId) api.reset(widgetId);
  }, [resetKey]);

  return (
    <div
      ref={containerRef}
      id={id}
      className={className}
      style={style}
      role="group"
      aria-label={ariaLabel}
      data-turnstile-widget=""
    />
  );
});

export default TurnstileWidget;
