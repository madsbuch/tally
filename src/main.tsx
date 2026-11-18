import React from "react";
import ReactDOM from "react-dom/client";
// Each screen is its own chunk, loaded when first opened: the app starts on
// what the first screen needs, and the pairing screen's QR reader (jsqr)
// costs nothing until you pair.
import { Routes } from "@generouted/react-router/lazy";
import "./App.css";
import { installTheme } from "./lib/theme";

// Before the first render, so a pinned theme never flashes the other one.
installTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Routes />
  </React.StrictMode>,
);
