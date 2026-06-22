import axios from "axios";

const API_BASE = (import.meta.env.VITE_API_BASE || `http://${window.location.hostname}:8090/api`).replace(/\/$/, "");

const client = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
  headers: {
    "Content-Type": "application/json",
  },
});

const normalizeError = (error) => {
  const payload = error.response?.data;
  const serverMessage = payload?.message || payload?.error;
  const message =
    serverMessage ||
    (error.code === "ECONNABORTED" ? "请求超时，请确认后端服务是否正常" : error.message) ||
    "请求失败";

  const normalized = new Error(message);
  normalized.status = error.response?.status;
  normalized.payload = payload;
  return normalized;
};

const request = async (promise) => {
  try {
    const response = await promise;
    return response.data;
  } catch (error) {
    throw normalizeError(error);
  }
};

const safeArray = (value) => (Array.isArray(value) ? value : []);

export const api = {
  fetchConfig: () => request(client.get("/config")),
  saveConfig: (data) => request(client.post("/config", data)),
  fetchDashboards: async () => {
    const data = await request(client.get("/dashboards"));
    return safeArray(data.dashboards);
  },
  getDashboardUrl: (filename) => `${API_BASE}/dashboards/${encodeURIComponent(filename)}`,
  fetchLogs: async () => {
    const data = await request(client.get("/logs"));
    return safeArray(data.logs);
  },
  fetchContexts: async () => {
    const data = await request(client.get("/contexts"));
    return safeArray(data.contexts);
  },
  triggerJob: (jobName, dryRun = true) => request(client.post(`/jobs/${encodeURIComponent(jobName)}`, { dryRun })),
};
