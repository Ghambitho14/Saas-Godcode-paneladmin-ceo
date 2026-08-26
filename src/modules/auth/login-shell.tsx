import { useEffect, useState } from "react";
import { LoginForm } from "./login-form";
import { resetDocumentMeta } from "@/shared/utils/documentMeta";

interface LoginShellProps {
  displayName: string;
}

type AccessMode = "caja" | "admin";

export function LoginShell({ }: LoginShellProps) {
  const [accessMode, setAccessMode] = useState<AccessMode>("caja");

  const handleTabChange = (mode: AccessMode) => {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(10); // Light haptic feedback
    }
    setAccessMode(mode);
  };

  useEffect(() => {
    resetDocumentMeta();
  }, []);

  return (
    <main className="login-shell" data-mode={accessMode}>
      {/* SVG Coral Organic Waves – large, sharp blobs */}
      <div className="login-waves" aria-hidden="true">
        <svg className="login-wave login-wave--top" viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
          <path d="M260 0C260 0 310 80 380 140C430 185 500 220 500 220V0H260Z" fill="#FF6452"/>
          <path d="M360 0C360 0 400 60 440 100C470 130 500 155 500 155V0H360Z" fill="#FF7866" fillOpacity="0.5"/>
          <path d="M180 0C200 30 250 100 320 150C400 210 460 280 500 350V260C480 200 440 140 380 100C320 60 280 30 260 0H180Z" fill="#FF6452" fillOpacity="0.7"/>
        </svg>
        <svg className="login-wave login-wave--bottom" viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
          <path d="M0 280C0 280 70 200 140 180C210 160 250 200 240 280C230 360 200 420 160 460C120 500 0 500 0 500V280Z" fill="#FF6452"/>
          <path d="M0 360C0 360 50 300 100 290C150 280 180 310 170 360C160 410 130 450 100 470C70 490 0 500 0 500V360Z" fill="#FF7866" fillOpacity="0.5"/>
        </svg>
      </div>

      {/* Logo – no circle wrapper, just the image */}
      <div className="login-logo-wrap" aria-hidden="true">
        <img src="/gcode-hero-logo-v3.png" alt="" className="login-logo" />
      </div>

      {/* Title & subtitle */}
      <h1 className="login-title">¡Bienvenido de nuevo!</h1>
      <p className="login-subtitle">
        {accessMode === "caja" ? (
          <>
            Ingresa a <strong className="login-highlight">GCode</strong> para comenzar tu turno y gestionar las ventas del día.
          </>
        ) : (
          <>
            Accede a la administración web de <strong className="login-highlight">GCode</strong> para configurar tu negocio.
          </>
        )}
      </p>

      {/* Form card */}
      <div className="login-card-wrap">
        {/* Tabs: Login / Acceso Admin */}
        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab${accessMode === "caja" ? " login-tab--active" : ""}`}
            onClick={() => handleTabChange("caja")}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            className={`login-tab${accessMode === "admin" ? " login-tab--active" : ""}`}
            onClick={() => handleTabChange("admin")}
          >
            Acceso Admin
          </button>
        </div>

        {/* Form body */}
        <div className="login-card-body">
          {accessMode === "caja" ? (
            <LoginForm />
          ) : (
            <div className="login-admin-body">
              <p className="login-admin-text">
                Accede al portal de administración para configurar tu empresa, gestionar reportes y permisos avanzados.
              </p>
              <a
                className="login-submit-btn"
                href="https://www.godcode.me/login"
                target="_blank"
                rel="noopener noreferrer"
              >
                Acceso GCode (web)
              </a>
            </div>
          )}
        </div>
      </div>

      <p className="login-help">
        ¿Problemas para ingresar? Contacta al administrador de la empresa.
      </p>
    </main>
  );
}
