import Link from "next/link";

interface Props {
  size?: "sm" | "md" | "lg";
  linkTo?: string;
  showMark?: boolean;
  tagline?: boolean;
}

/**
 * The Podcast Studio wordmark. Matches abdallahhelal.com's "AH." style — a
 * circular coral mark beside a bold wordmark, with a trailing period.
 */
export function Logo({ size = "md", linkTo = "/", showMark = true, tagline = false }: Props) {
  const scale = size === "sm" ? "text-sm" : size === "lg" ? "text-2xl md:text-3xl" : "text-lg md:text-xl";
  const markSize =
    size === "sm" ? "w-6 h-6 text-[11px]" : size === "lg" ? "w-10 h-10 text-sm" : "w-8 h-8 text-xs";

  const body = (
    <span className="inline-flex items-center gap-2">
      {showMark && (
        <span
          aria-hidden
          className={`${markSize} shrink-0 inline-flex items-center justify-center rounded-full font-black text-white shadow-md`}
          style={{ background: "var(--gradient-sunset)" }}
        >
          PS
        </span>
      )}
      <span className={`${scale} font-black tracking-tight text-ink leading-none`}>
        Podcast Studio<span className="text-coral-600">.</span>
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-0.5">
      {linkTo ? (
        <Link href={linkTo} className="inline-block">
          {body}
        </Link>
      ) : (
        body
      )}
      {tagline && (
        <span className="text-xs text-ink-muted ml-10">Record together. Each side uploads its own.</span>
      )}
    </div>
  );
}
