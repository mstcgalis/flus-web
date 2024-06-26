/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    colors: {
      pink: "#A5609F",
      grey: "#E8E8E8",
    },
    extend: {
      typography: ({ theme }) => ({
        pink: {
          css: {
            "--tw-prose-bullets": "#A5609F",
          },
        },
      }),
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
