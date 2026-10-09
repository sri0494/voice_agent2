import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import DashboardLayout from "./layouts/DashboardLayout.jsx";
import { LoadingState } from "./components/DataState.jsx";

import Login from "./pages/Login.jsx";
import ContactUs from "./pages/ContactUs.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Customers from "./pages/Customers.jsx";
import CustomerDetail from "./pages/CustomerDetail.jsx";
import Campaigns from "./pages/Campaigns.jsx";
import CampaignDetail from "./pages/CampaignDetail.jsx";
import LiveCalls from "./pages/LiveCalls.jsx";
import Calls from "./pages/Calls.jsx";
import CallDetail from "./pages/CallDetail.jsx";
import Agents from "./pages/ai-engine/Agents.jsx";
import AgentDetail from "./pages/ai-engine/AgentDetail.jsx";
import KnowledgeBase from "./pages/KnowledgeBase.jsx";
import KnowledgeBaseDetail from "./pages/KnowledgeBaseDetail.jsx";
import PhoneNumbers from "./pages/PhoneNumbers.jsx";
import Analytics from "./pages/Analytics.jsx";
import Integrations from "./pages/Integrations.jsx";
import Settings from "./pages/Settings.jsx";
import ContactRequests from "./pages/ContactRequests.jsx";
import Surveys from "./pages/Surveys.jsx";
import SurveyDetail from "./pages/SurveyDetail.jsx";
import AgentSteering from "./pages/ai-engine/AgentSteering.jsx";
import ConversationTestPanel from "./pages/ai-engine/ConversationTestPanel.jsx";

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="login-wrap"><LoadingState label="Checking session..." /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <div className="login-wrap"><LoadingState /></div> : user ? <Navigate to="/dashboard" replace /> : <Login />}
      />
      <Route path="/contact" element={<ContactUs />} />

      <Route
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />
        <Route path="/live-calls" element={<LiveCalls />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/calls/:id" element={<CallDetail />} />
        <Route path="/ai-engine/agents" element={<Agents />} />
        <Route path="/ai-engine/agents/:id" element={<AgentDetail />} />
        <Route path="/ai-engine/agents/:id/steering" element={<AgentSteering />} />
        <Route path="/ai-engine/agents/:id/test" element={<ConversationTestPanel />} />
        <Route path="/knowledge-base" element={<KnowledgeBase />} />
        <Route path="/knowledge-base/:id" element={<KnowledgeBaseDetail />} />
        <Route path="/phone-numbers" element={<PhoneNumbers />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/contact-requests" element={<ContactRequests />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/surveys" element={<Surveys />} />
        <Route path="/surveys/:id" element={<SurveyDetail />} />
      </Route>

      <Route path="/" element={<Navigate to={user ? "/dashboard" : "/login"} replace />} />
      <Route path="*" element={<Navigate to={user ? "/dashboard" : "/login"} replace />} />
    </Routes>
  );
}
