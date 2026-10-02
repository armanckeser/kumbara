// The public demo's footer: what a stranger is looking at, where to get the real thing, who made it, and what the
// page collects. Rendered only in a demo build (see __root.tsx), so a self-hosted Kumbara never shows it. It is
// the one place the app names its author's site, which is why the publish gate's personal-domain rule is allowed
// for this file and nowhere else.
const linkClass =
  "text-text-secondary underline decoration-border underline-offset-4 transition-colors hover:text-text-primary";

export function DemoCredit() {
  return (
    <footer className="mt-12 text-center text-xs leading-relaxed text-text-secondary/70">
      <p>A demo with an invented household. Nothing you enter leaves your browser.</p>
      <p>
        <a href="https://github.com/armanckeser/kumbara" target="_blank" rel="noopener" className={linkClass}>
          Self-host Kumbara from GitHub
        </a>
        <span aria-hidden> · </span>
        Made by{" "}
        <a href="https://armanckeser.com" target="_blank" rel="noopener" className={linkClass}>
          Armanc Keser
        </a>
        <span aria-hidden> · </span>
        <a href="https://armanckeser.com/privacy#demos" target="_blank" rel="noopener" className={linkClass}>
          Privacy
        </a>
      </p>
    </footer>
  );
}
