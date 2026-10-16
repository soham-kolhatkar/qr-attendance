/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Empty in development (requests go through the Vite proxy). */
  readonly VITE_API_URL?: string;
}
