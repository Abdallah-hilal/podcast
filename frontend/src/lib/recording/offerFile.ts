export type ShareNavigator = {
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[]; title?: string }) => Promise<void>;
};

/**
 * Hand the user their local copy: the native share sheet where the browser
 * supports sharing files (iOS, Android, Chrome on macOS), else `fallback`
 * (a programmatic download). Never waits for the sheet — a user who leaves
 * it open must not block the next stop or a Leave click.
 */
export function offerFile(
  file: File,
  nav: ShareNavigator,
  fallback: () => void,
  onShared: () => void,
): "share" | "fallback" {
  if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    nav.share({ files: [file], title: "Podcast recording" }).then(onShared, (e) => {
      // AbortError = user cancelled the sheet; the Download card stays up.
      // Anything else (e.g. NotAllowedError when the click's activation has
      // expired) → fall back to a plain download.
      if ((e as { name?: string })?.name !== "AbortError") fallback();
    });
    return "share";
  }
  fallback();
  return "fallback";
}
