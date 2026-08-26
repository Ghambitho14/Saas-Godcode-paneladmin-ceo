import { useEffect, useRef, useState } from "react";
import { useAntiZoom, syncMobileViewportVars } from "./use-anti-zoom";
import { PwaInstallHint } from "./components/PwaInstallHint";
import { isStandaloneDisplayMode } from "./utils/pwa-install";
import "./styles/pwa-standalone.css";

interface AppShellProps {
  children: React.ReactNode;
}

/** Shell visual legado (clases `tenant-*` conservadas para paridad 1:1). */
export function AppShell({ children }: AppShellProps) {
  const [scrollY, setScrollY] = useState(0);
  const bgLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      const shell = document.querySelector(".tenant-shell-root");
      const y =
        shell instanceof HTMLElement ? shell.scrollTop : window.scrollY;
      setScrollY(y);
    };
    handleScroll();
    const shell = document.querySelector(".tenant-shell-root");
    shell?.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      shell?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useAntiZoom();

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (isStandaloneDisplayMode()) root.classList.add("pwa-standalone");
      else root.classList.remove("pwa-standalone");
    };
    apply();
    window.addEventListener("visibilitychange", apply);
    window.addEventListener("pageshow", apply);
    window.addEventListener("focus", apply);

    const standaloneMq = window.matchMedia("(display-mode: standalone)");
    const onMqChange = () => apply();
    standaloneMq.addEventListener?.("change", onMqChange);

    return () => {
      window.removeEventListener("visibilitychange", apply);
      window.removeEventListener("pageshow", apply);
      window.removeEventListener("focus", apply);
      standaloneMq.removeEventListener?.("change", onMqChange);
    };
  }, []);

  useEffect(() => {
    const sync = () => syncMobileViewportVars();
    const shell = document.querySelector(".tenant-shell-root");
    shell?.addEventListener("scroll", sync, { passive: true });
    return () => shell?.removeEventListener("scroll", sync);
  }, []);

  useEffect(() => {
    if (!bgLayerRef.current) return;
    bgLayerRef.current.style.transform = `translateY(${-scrollY * 0.1}px)`;
  }, [scrollY]);

  return (
    <div className="tenant-shell-root">
      <div ref={bgLayerRef} className="app-bg-layer tenant-shell-bg-layer" />
      <div id="app-content-layer" className="app-wrapper tenant-content-layer">
        {children}
      </div>
      <div id="app-ui-layer" className="tenant-ui-layer">
        <div id="modal-root" className="tenant-portal-modal" />
        <PwaInstallHint />
      </div>
    </div>
  );
}
