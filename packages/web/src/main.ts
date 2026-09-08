import { mount } from "svelte";
import App from "./App.svelte";
import { pinToVisualViewport } from "./lib/keyboard.ts";
// Self-hosted faces — the daemon serves everything itself, offline included.
// Archivo is the instrument's silkscreen and reading voice; JetBrains Mono
// is machine truth (tools, code, paths, numbers).
import "@fontsource-variable/archivo";
import "@fontsource-variable/archivo/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./app.css";

const app = document.getElementById("app")!;
pinToVisualViewport(app);

export default mount(App, { target: app });
