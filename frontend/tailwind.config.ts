import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17201f",
        paper: "#f7f8f4",
        moss: "#557a68",
        coral: "#c96950",
        line: "#dfe5dc",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Arial", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      boxShadow: {
        soft: "0 18px 50px rgba(45, 61, 53, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
