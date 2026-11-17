import React from "react";
import ReactDOM from "react-dom/client";
import { Routes } from "@generouted/react-router";
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
