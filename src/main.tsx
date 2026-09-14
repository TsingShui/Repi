import { render } from "@solidjs/web";
import { App } from "./app";
import "./styles/global.css";
import "./app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Repi could not find its #root mount point.");
}

render(() => <App />, root);
