import axios from "axios";

const API_BASE = ((import.meta as any).env?.VITE_API_BASE || `http://${window.location.hostname}:8090/api`).replace(/\/$/, "");

const client = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
  headers: {
    "Content-Type": "application/json",
  },
});

interface ApiError extends Error {
  status?: number;
  payload?: any;
}

const normalizeError = (error: any): ApiError => {
  const payload = error.response?.data;
  const serverMessage = payload?.message || payload?.error;
  const message =
    serverMessage ||
    (error.code === "ECONNABORTED" ? "请求超时，请确认后端服务是否正常" : error.message) ||
    "请求失败";

  const normalized = new Error(message) as ApiError;
  normalized.status = error.response?.status;
  normalized.payload = payload;
  return normalized;
};

const request = async (promise: Promise<any>) => {
  try {
    const response = await promise;
    return response.data;
  } catch (error) {
    throw normalizeError(error);
  }
};

const safeArray = (value: any) => (Array.isArray(value) ? value : []);

export const api = {
  fetchConfig: () => request(client.get("/config")),
  saveConfig: (data: any) => request(client.post("/config", data)),
  fetchDashboards: async () => {
    const data = await request(client.get("/dashboards"));
    return safeArray(data.dashboards);
  },
  getDashboardUrl: (filename: string) => `${API_BASE}/dashboards/${encodeURIComponent(filename)}`,
  fetchLogs: async (page = 1, pageSize = 20, filters: any = {}) => {
    let url = `/logs?page=${page}&pageSize=${pageSize}`;
    if (filters.startDate) url += `&startDate=${filters.startDate}`;
    if (filters.endDate) url += `&endDate=${filters.endDate}`;
    if (filters.eventType && filters.eventType !== 'all') url += `&eventType=${filters.eventType}`;
    if (filters.groupId && filters.groupId !== 'all') url += `&groupId=${filters.groupId}`;
    const data = await request(client.get(url));
    return data;
  },
  fetchContexts: async (page = 1, pageSize = 15, filters: any = {}) => {
    let url = `/contexts?page=${page}&pageSize=${pageSize}`;
    if (filters.startDate) url += `&startDate=${filters.startDate}`;
    if (filters.endDate) url += `&endDate=${filters.endDate}`;
    if (filters.contextType && filters.contextType !== 'all') url += `&contextType=${filters.contextType}`;
    if (filters.chatType && filters.chatType !== 'all') url += `&chatType=${filters.chatType}`;
    if (filters.targetOpenId && filters.targetOpenId !== 'all') url += `&targetOpenId=${filters.targetOpenId}`;
    if (filters.groupId && filters.groupId !== 'all') url += `&groupId=${filters.groupId}`;
    const data = await request(client.get(url));
    return data;
  },
  fetchGroups: async () => {
    const data = await request(client.get("/feishu/groups"));
    return safeArray(data.groups);
  },
  fetchGroupMembers: async (chatId: string) => {
    const data = await request(client.get(`/feishu/groups/${chatId}/members`));
    return safeArray(data.members);
  },
  fetchMeetingSummaries: async (groupId?: string) => {
    const data = await request(client.get(`/meeting-summaries${groupId ? '?groupId=' + encodeURIComponent(groupId) : ''}`));
    return safeArray(data.summaries);
  },
  fetchMeetingSummaryContent: async (filepath: string) => {
    const data = await request(client.get(`/meeting-summaries/file/${filepath.split('/').map(encodeURIComponent).join('/')}`));
    return data;
  },
  getMeetingSummaryFileUrl: (filepath: string) => `${API_BASE}/meeting-summaries/file/${filepath.split('/').map(encodeURIComponent).join('/')}`,
  sendMeetingSummaryEmail: async (id: string) => {
    const data = await request(client.post(`/meeting-summaries/${id}/send-email`));
    return data;
  },
  fetchStandups: (date: string, groupId: string) => request(client.get(`/standups?date=${date}${groupId ? '&groupId=' + encodeURIComponent(groupId) : ''}`)),
  triggerJob: (jobName: string, groupId: string, dryRun = true) => request(client.post(`/jobs/${encodeURIComponent(jobName)}`, { groupId, dryRun })),
};
