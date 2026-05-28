import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'validate-mw-api-base-url',
      configResolved() {
        const value = process.env.VITE_MW_API_BASE_URL;
        if (!value || value.trim() === '') {
          throw new Error(
            'VITE_MW_API_BASE_URL is required. Set it before building or starting the dev server.\n' +
            'Example: VITE_MW_API_BASE_URL=http://localhost:8080 pnpm run build\n' +
            'In Docker Compose this is set automatically via docker-compose.yml environment.'
          );
        }
      },
    },
  ],
});
