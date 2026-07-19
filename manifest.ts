import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,

  name: "LinkedIn Invite Tracker",

  description: "Track LinkedIn connection requests",

  version: "1.0.0",

  permissions: ["storage", "alarms"],

  host_permissions: ["https://www.linkedin.com/*"],

  action: {
  default_popup: "popup.html",
},

  background: {
    service_worker: "src/background/background.ts",
    type: "module"
  },

  content_scripts: [
    {
      matches: ["https://www.linkedin.com/*"],
      js: ["src/content/content.ts"]
    }
  ]
});