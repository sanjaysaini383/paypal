// Apply the saved theme before first paint to avoid a flash. Loaded as a
// blocking script from <head>; kept external so the CSP can forbid inline scripts.
try {
  const t = localStorage.getItem("cartpilot-theme");
  if (t) document.documentElement.dataset.theme = t;
} catch {}
