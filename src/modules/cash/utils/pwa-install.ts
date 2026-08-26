const DISMISS_KEY = "godcode-pwa-install-dismissed";

export function isStandaloneDisplayMode(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		window.matchMedia("(display-mode: fullscreen)").matches ||
		window.matchMedia("(display-mode: minimal-ui)").matches ||
		// Safari iOS
		Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
	);
}

export function isIosDevice(): boolean {
	if (typeof navigator === "undefined") return false;
	return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Safari en iOS (no Chrome/Firefox en iOS). */
export function isIosSafari(): boolean {
	if (!isIosDevice()) return false;
	const ua = navigator.userAgent;
	return /webkit/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

export function wasInstallHintDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

export function dismissInstallHint(): void {
	try {
		localStorage.setItem(DISMISS_KEY, "1");
	} catch {
		/* ignore */
	}
}

export function shouldShowIosInstallHint(): boolean {
	if (typeof window === "undefined") return false;
	if (isStandaloneDisplayMode()) return false;
	if (!isIosSafari()) return false;
	if (wasInstallHintDismissed()) return false;
	return true;
}
