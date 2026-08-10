/** Fallback del `<link rel="icon">` en `index.html` (public/favicon.png). */
export const DEFAULT_FAVICON_HREF = "/favicon.png";

/**
 * URL lista para <img> / favicon.
 * - https (y http en DEV): se aceptan
 * - rutas absolutas de la app (`/…`): se aceptan
 * - paths relativos de Storage (`uuid/storefront/…`): se rechazan (no son del origin)
 */
export function getSafeFaviconUrl(logoUrl: string | null | undefined): string | null {
	if (logoUrl == null || !String(logoUrl).trim()) return null;
	const trimmed = String(logoUrl).trim();

	// Evita `new URL('uuid/…', origin)` → `https://panel/uuid/…` (roto).
	if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("/")) {
		return null;
	}

	try {
		const parsed = new URL(trimmed, typeof window !== "undefined" ? window.location.origin : "http://localhost");
		if (parsed.protocol === "https:") return parsed.href;
		if (import.meta.env.DEV && parsed.protocol === "http:") return parsed.href;
		return null;
	} catch {
		return null;
	}
}

/**
 * Src para el logo del sidebar / branding en UI.
 * Acepta solo URLs http(s) ya resueltas (Storage público, Cloudinary, etc.).
 */
export function getSafeLogoImageSrc(logoUrl: string | null | undefined): string {
	const trimmed = String(logoUrl ?? "").trim();
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const host = new URL(trimmed).hostname.toLowerCase();
			if (host === "res.cloudinary.com" || host.endsWith(".cloudinary.com")) {
				return DEFAULT_FAVICON_HREF;
			}
		} catch {
			/* URL inválida → fallback abajo */
			return DEFAULT_FAVICON_HREF;
		}
		return trimmed;
	}
	const safe = getSafeFaviconUrl(trimmed);
	return safe || DEFAULT_FAVICON_HREF;
}

function faviconMimeType(href: string): string {
	const path = href.split("?")[0].toLowerCase();
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	if (path.endsWith(".webp")) return "image/webp";
	return "image/png";
}

/**
 * Actualiza el icono de la pestaña. Si `logoUrl` es inválido o vacío, usa `DEFAULT_FAVICON_HREF`.
 */
export function applyDocumentFavicon(logoUrl: string | null | undefined): void {
	if (typeof document === "undefined") return;
	const safe = getSafeFaviconUrl(logoUrl);
	const href = safe ?? DEFAULT_FAVICON_HREF;

	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.type = faviconMimeType(href);
	link.href = href;
}
