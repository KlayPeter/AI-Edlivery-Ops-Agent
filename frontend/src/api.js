import axios from 'axios';

// The backend runs on port 8090 locally.
const API_BASE = 'http://127.0.0.1:8090/api';

export const api = {
  fetchConfig: () => axios.get(`${API_BASE}/config`).then(res => res.data),
  saveConfig: (data) => axios.post(`${API_BASE}/config`, data).then(res => res.data),
  fetchDashboards: () => axios.get(`${API_BASE}/dashboards`).then(res => res.data.dashboards),
  getDashboardUrl: (filename) => `${API_BASE}/dashboards/${filename}`,
  fetchLogs: () => axios.get(`${API_BASE}/logs`).then(res => res.data.logs),
  fetchContexts: () => axios.get(`${API_BASE}/contexts`).then(res => res.data.contexts),
  triggerJob: (jobName, dryRun = true) => 
    axios.post(`${API_BASE}/jobs/${jobName}`, { dryRun }).then(res => res.data),
};
