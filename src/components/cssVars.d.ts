import "react";

// CSS custom properties (`--level`, …) in inline styles. React's
// CSSProperties has no index signature for them, so without this every
// `style={{ "--x": v }}` would need a cast.
declare module "react" {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
