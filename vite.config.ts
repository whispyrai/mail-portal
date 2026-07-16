// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      remoteBindings: false,
      ...(process.env.MAIL_PORTAL_PLAYWRIGHT_CONFIG
        ? {
            configPath: process.env.MAIL_PORTAL_PLAYWRIGHT_CONFIG,
          }
        : {}),
      ...(process.env.MAIL_PORTAL_PLAYWRIGHT_STATE
        ? { persistState: { path: process.env.MAIL_PORTAL_PLAYWRIGHT_STATE } }
        : {}),
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
