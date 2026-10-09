// Central API layer. Never call fetch() directly from components — go through here.
// In production the Express server serves the built SPA, so relative "/api/..."
// paths work with no VITE_API_URL configured. Set VITE_API_URL only for local
// `vite dev` against a separately-hosted API.
const BASE_URL = import.meta.env.VITE_API_URL || "";

function getToken() {
  return localStorage.getItem("leomox_token");
}

async function request(path, { method = "GET", body, headers = {}, isFormData = false } = {}) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    json = { success: false, message: "Unexpected server response" };
  }

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// ---------- Auth ----------
export const login = (email, password) => request("/auth/login", { method: "POST", body: { email, password } });
export const logout = () => request("/auth/logout", { method: "POST" });
export const getCurrentUser = () => request("/auth/me");
export const changePassword = (currentPassword, newPassword) =>
  request("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });

// ---------- Users ----------
export const getUsers = () => request("/users");
export const createUser = (data) => request("/users", { method: "POST", body: data });
export const updateUser = (id, data) => request(`/users/${id}`, { method: "PUT", body: data });
export const disableUser = (id) => request(`/users/${id}/disable`, { method: "POST" });
export const resetUserPassword = (id, newPassword) => request(`/users/${id}/reset-password`, { method: "POST", body: { newPassword } });

// ---------- Agents ----------
export const getAgents = () => request("/agents");
export const getAgent = (id) => request(`/agents/${id}`);
export const createAgent = (data) => request("/agents", { method: "POST", body: data });
export const updateAgent = (id, data) => request(`/agents/${id}`, { method: "PUT", body: data });
export const deleteAgent = (id) => request(`/agents/${id}`, { method: "DELETE" });
export const testAgent = (id, message) => request(`/agents/${id}/test`, { method: "POST", body: { message } });

// ---------- Campaigns ----------
export const getCampaigns = () => request("/campaigns");
export const getCampaign = (id) => request(`/campaigns/${id}`);
export const createCampaign = (data) => request("/campaigns", { method: "POST", body: data });
export const updateCampaign = (id, data) => request(`/campaigns/${id}`, { method: "PUT", body: data });
export const startCampaign = (id) => request(`/campaigns/${id}/start`, { method: "POST" });
export const pauseCampaign = (id) => request(`/campaigns/${id}/pause`, { method: "POST" });
export const resumeCampaign = (id) => request(`/campaigns/${id}/resume`, { method: "POST" });
export const stopCampaign = (id) => request(`/campaigns/${id}/stop`, { method: "POST" });
export const deleteCampaign = (id) => request(`/campaigns/${id}`, { method: "DELETE" });

// ---------- Contacts ----------
export const getContacts = (campaignId) => request(`/contacts${campaignId ? `?campaignId=${campaignId}` : ""}`);
export const createContact = (data) => request("/contacts", { method: "POST", body: data });
export const uploadContactsCsv = (file, campaignId) => {
  const form = new FormData();
  form.append("file", file);
  if (campaignId) form.append("campaignId", campaignId);
  return request("/contacts/upload-csv", { method: "POST", body: form, isFormData: true });
};
export const deleteContact = (id) => request(`/contacts/${id}`, { method: "DELETE" });

// ---------- Calls ----------
export const getCalls = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/calls${qs ? `?${qs}` : ""}`);
};
export const getLiveCalls = () => request("/calls/live");
export const getCall = (id) => request(`/calls/${id}`);
export const transferCall = (id, toNumber) => request(`/calls/${id}/transfer`, { method: "POST", body: { toNumber } });
export const endCall = (id) => request(`/calls/${id}/end`, { method: "POST" });
export const placeCall = (campaignId, contactId) => request("/telephony/call", { method: "POST", body: { campaignId, contactId } });

// ---------- Knowledge base ----------
export const getKnowledgeBases = () => request("/knowledge-bases");
export const getKnowledgeBase = (id) => request(`/knowledge-bases/${id}`);
export const createKnowledgeBase = (data) => request("/knowledge-bases", { method: "POST", body: data });
export const updateKnowledgeBase = (id, data) => request(`/knowledge-bases/${id}`, { method: "PUT", body: data });
export const deleteKnowledgeBase = (id) => request(`/knowledge-bases/${id}`, { method: "DELETE" });
export const addKnowledgeText = (id, title, text) => request(`/knowledge-bases/${id}/text`, { method: "POST", body: { title, text } });
export const addKnowledgeFaq = (id, question, answer) => request(`/knowledge-bases/${id}/faq`, { method: "POST", body: { question, answer } });

export const uploadDocument = (file, knowledgeBaseId) => {
  const form = new FormData();
  form.append("file", file);
  form.append("knowledgeBaseId", knowledgeBaseId);
  return request("/documents/upload", { method: "POST", body: form, isFormData: true });
};
export const reindexDocument = (id) => request(`/documents/${id}/reindex`, { method: "POST" });
export const deleteDocument = (id) => request(`/documents/${id}`, { method: "DELETE" });
export const searchDocuments = (knowledgeBaseId, q) => request(`/documents?knowledgeBaseId=${knowledgeBaseId}${q ? `&q=${encodeURIComponent(q)}` : ""}`);

// ---------- RAG ----------
export const queryRag = (agentId, question) => request("/rag/query", { method: "POST", body: { agentId, question } });

// ---------- Contact requests ----------
export const sendContactRequest = (data) => request("/contact-requests", { method: "POST", body: data });
export const getContactRequests = (status) => request(`/contact-requests${status ? `?status=${status}` : ""}`);
export const updateContactRequest = (id, status) => request(`/contact-requests/${id}`, { method: "PUT", body: { status } });

// ---------- Analytics ----------
export const getAnalyticsSummary = (range) => request(`/analytics/summary?range=${range || "30d"}`);
export const getCallsByDay = (range) => request(`/analytics/calls-by-day?range=${range || "30d"}`);
export const getCallsByCampaign = () => request("/analytics/calls-by-campaign");
export const getCallsByLanguage = () => request("/analytics/calls-by-language");
export const getOutcomes = () => request("/analytics/outcomes");
export const getSentiment = () => request("/analytics/sentiment");

// ---------- Integrations ----------
export const getIntegrations = () => request("/integrations");

// ---------- Customers ----------
export const getCustomers = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/customers${qs ? `?${qs}` : ""}`);
};
export const getCustomer = (id) => request(`/customers/${id}`);
export const createCustomer = (data) => request("/customers", { method: "POST", body: data });
export const updateCustomer = (id, data) => request(`/customers/${id}`, { method: "PUT", body: data });
export const deleteCustomer = (id) => request(`/customers/${id}`, { method: "DELETE" });
export const convertContactToCustomer = (contactId) => request(`/customers/convert-from-contact/${contactId}`, { method: "POST" });

// ---------- Business Integrations (REST API connectors) ----------
export const getBusinessIntegrations = () => request("/business-integrations");
export const createBusinessIntegration = (data) => request("/business-integrations", { method: "POST", body: data });
export const updateBusinessIntegration = (id, data) => request(`/business-integrations/${id}`, { method: "PUT", body: data });
export const deleteBusinessIntegration = (id) => request(`/business-integrations/${id}`, { method: "DELETE" });
export const addIntegrationFunction = (integrationId, data) => request(`/business-integrations/${integrationId}/functions`, { method: "POST", body: data });
export const deleteIntegrationFunction = (functionId) => request(`/business-integrations/functions/${functionId}`, { method: "DELETE" });
export const testIntegrationFunction = (functionId, params) => request(`/business-integrations/functions/${functionId}/test`, { method: "POST", body: { params } });
export const getAgentFunctions = (agentId) => request(`/business-integrations/agents/${agentId}/functions`);
export const setAgentFunctions = (agentId, functionIds) => request(`/business-integrations/agents/${agentId}/functions`, { method: "PUT", body: { functionIds } });

// ---------- Phone Numbers ----------
export const getPhoneNumbers = () => request("/phone-numbers");
export const createPhoneNumber = (data) => request("/phone-numbers", { method: "POST", body: data });
export const updatePhoneNumber = (id, data) => request(`/phone-numbers/${id}`, { method: "PUT", body: data });
export const deletePhoneNumber = (id) => request(`/phone-numbers/${id}`, { method: "DELETE" });

// ---------- Surveys ----------
export const getSurveys = () => request("/surveys");
export const getSurvey = (id) => request(`/surveys/${id}`);
export const createSurvey = (data) => request("/surveys", { method: "POST", body: data });
export const updateSurvey = (id, data) => request(`/surveys/${id}`, { method: "PUT", body: data });
export const deleteSurvey = (id) => request(`/surveys/${id}`, { method: "DELETE" });
export const addSurveyQuestion = (surveyId, data) => request(`/surveys/${surveyId}/questions`, { method: "POST", body: data });
export const deleteSurveyQuestion = (questionId) => request(`/surveys/questions/${questionId}`, { method: "DELETE" });
export const submitSurveyResponse = (surveyId, data) => request(`/surveys/${surveyId}/responses`, { method: "POST", body: data });
export const getSurveyResults = (surveyId) => request(`/surveys/${surveyId}/results`);

// ---------- Conversation Intelligence ----------
export const processConversation = (agentId, customerText, conversationHistory, sessionId, callId) =>
  request("/conversation/process", { method: "POST", body: { agentId, customerText, conversationHistory, sessionId, callId } });
export const getConversationSession = (sessionId) => request(`/conversation/sessions/${sessionId}`);
export const getCallConversationSession = (callId) => request(`/conversation/calls/${callId}/session`);

// ---------- Agent Steering / Objective Config ----------
export const getAgentSteering = (agentId) => request(`/agent-steering/${agentId}`);
export const updateAgentSteering = (agentId, data) => request(`/agent-steering/${agentId}`, { method: "PUT", body: data });

export function setAuthToken(token) {
  if (token) localStorage.setItem("leomox_token", token);
  else localStorage.removeItem("leomox_token");
}
export { getToken };
