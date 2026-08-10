import { useEffect, useState } from "react";
import { LoginForm } from "./login-form";
import { resetDocumentMeta } from "@/shared/utils/documentMeta";
import { Button } from "@/components/ui/button";

interface LoginShellProps {
  displayName: string;
}

type AccessMode = "caja" | "admin";

export function LoginShell({ displayName }: LoginShellProps) {
  const [accessMode, setAccessMode] = useState<AccessMode>("caja");
  const [introDone, setIntroDone] = useState(false);

  useEffect(() => {
    resetDocumentMeta();
  }, []);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setIntroDone(true);
      return;
    }
    const timer = window.setTimeout(() => setIntroDone(true), 2000);
    return () => window.clearTimeout(timer);
  }, []);

  const panelCopy =
    accessMode === "caja"
      ? {
          heading: "¿Administración?",
          line: "Configura el local, reportes y permisos avanzados.",
          action: "admin" as const,
          buttonLabel: "Acceso admin",
        }
      : {
          heading: "¿Operación de caja?",
          line: "Cobros, turnos y uso diario del panel en este equipo.",
          action: "caja" as const,
          buttonLabel: "Acceso caja",
        };

  return (
    <main className="login-shell login-shell--split" data-mode={accessMode}>
      <div className="login-slide-card glass animate-fade" data-mode={accessMode}>
        <h1 className="login-slide-brand">{displayName}</h1>

        <div className="login-slide-forms" aria-live="polite">
          <div className="login-form-plate">
            <header className="login-slide-form-header">
              <h2 className="login-slide-title">
                {accessMode === "caja" ? "Acceso caja" : "Acceso admin"}
              </h2>
              <p className="login-slide-subtitle">
                {accessMode === "caja"
                  ? "Ingresa con tu cuenta para operar caja en este local."
                  : "Continúa en el portal web de GodCode para acceder al panel de administración."}
              </p>
            </header>
            <div className="login-slide-actions">
              {accessMode === "caja" ? (
                <LoginForm />
              ) : (
                <p className="login-admin-external-wrap">
                  <a
                    className="login-submit-button login-admin-external-link"
                    href="https://www.godcode.me/login"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Acceso GodCode (web)
                  </a>
                </p>
              )}
            </div>
            <p className="login-slide-help">
              ¿Problemas para ingresar? Contacta al administrador de la empresa.
            </p>
          </div>
        </div>

        <aside className="login-sliding-panel" aria-label="Cambiar tipo de acceso">
          <div className="login-sliding-panel__inner">
            <div
              className={`login-sliding-panel__deco${accessMode === "caja" && introDone ? " login-sliding-panel__deco--logo" : ""}`}
              aria-hidden="true"
            >
              {accessMode === "caja" ? (
                <>
                  <img
                    src="/Gcode-login.svg"
                    alt=""
                    className="login-sliding-panel__deco-img login-sliding-panel__deco-img--intro"
                  />
                  <img
                    src="/Gcode-mark.svg"
                    alt=""
                    className="login-sliding-panel__deco-img login-sliding-panel__deco-img--mark"
                  />
                </>
              ) : (
                <img
                  src="/favicon.png"
                  alt=""
                  className="login-sliding-panel__deco-img login-sliding-panel__deco-img--brand"
                />
              )}
            </div>
            <h3 className="login-sliding-panel__title">{panelCopy.heading}</h3>
            <p className="login-sliding-panel__text">{panelCopy.line}</p>
            <Button variant="default"
              type="button"
              className="login-sliding-panel__btn"
              onClick={() => setAccessMode(panelCopy.action)}
            >
              {panelCopy.buttonLabel}
            </Button>
          </div>
        </aside>
      </div>
    </main>
  );
}
