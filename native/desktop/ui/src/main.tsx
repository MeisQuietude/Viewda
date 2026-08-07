import { getThemePreference, showMainWindow } from "./desktop";
import { startApplication } from "./startup";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Viewda root element is missing");
}

void startApplication(root, showMainWindow, getThemePreference);
