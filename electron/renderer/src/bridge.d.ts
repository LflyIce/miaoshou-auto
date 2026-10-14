interface HistoryItem {
  fileName: string;
  date: string;
  sizeKb: number;
  mtime: string;
}

interface SearchItem {
  fileName: string;
  date: string;
  japaneseTitle: string;
  specifications: string;
  declaredPrice: string;
  productUrl: string;
}

interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
}

interface SettingsData {
  config: any;
  apiKey: string;
  apiKeys: Record<string, string>;
  apiKeyEnv: string;
  version: string;
  paths: Record<string, string>;
}

interface MiaoshouAPI {
  loadSettings: () => Promise<SettingsData>;
  saveSettings: (settings: any) => Promise<{ ok: boolean; error?: string }>;
  startTask: (taskName: string) => Promise<{ ok: boolean; error?: string }>;
  continueTask: () => Promise<{ ok: boolean; error?: string }>;
  stopTask: () => Promise<{ ok: boolean }>;
  openPath: (target: string) => Promise<{ ok: boolean; error?: string }>;
  listFillHistory: () => Promise<{ items: HistoryItem[] }>;
  openFillHistory: (fileName: string) => Promise<{ ok: boolean; error?: string }>;
  searchFillHistory: (query: string) => Promise<{ items: SearchItem[] }>;
  writeClipboard: (text: string) => Promise<{ ok: boolean }>;
  authStatus: () => Promise<{ configured: boolean }>;
  authLogin: (creds: { username: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  getUpdateStatus: () => Promise<UpdateInfo | null>;
  openDownloadUrl: () => Promise<{ ok: boolean; error?: string }>;
  onLog: (handler: (payload: { text: string; type: string }) => void) => void;
  onTaskState: (handler: (payload: { running: boolean; taskName: string }) => void) => void;
  onUpdateAvailable: (handler: (info: UpdateInfo) => void) => void;
}

declare global {
  interface Window {
    miaoshouApp: MiaoshouAPI;
  }
}

export {};
