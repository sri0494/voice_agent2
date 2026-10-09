import { http } from "../../services/http.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { Boundary, PageHeader, StatGrid, Table, fmtDate, fmtDur, useLoad } from "../ui.jsx";

export default function PortalDashboard({ me }) {
  const st = useLoad(() => http("/customer/dashboard"));
  const d = st.data || {};
  const cards = [
    ["Total Campaigns", d.totalCampaigns], ["Total Contacts", d.totalContacts], ["Total Calls", d.totalCalls],
    ["Completed Calls", d.completedCalls], ["Failed Calls", d.failedCalls], ["Recordings", d.totalRecordings],
  ].filter(([, v]) => v !== undefined);   // only modules the server returned

  return (
    <div>
      <PageHeader title={`Welcome, ${me.customer.companyName || me.customer.name}`} sub="Your campaigns and call activity" />
      <Boundary state={st}>
        <StatGrid items={cards} />
        {d.recentCampaigns && (
          <>
            <div style={{ fontWeight: 600, margin: "8px 0" }}>Recent Campaigns</div>
            {d.recentCampaigns.length ? (
              <Table head={["Campaign", "Status", "Calls"]}>
                {d.recentCampaigns.map((c) => <tr key={c.id}><td>{c.name}</td><td><StatusBadge status={c.status} /></td><td>{c.calls}</td></tr>)}
              </Table>
            ) : <div className="card">No campaigns yet.</div>}
          </>
        )}
        {d.recentCalls && (
          <>
            <div style={{ fontWeight: 600, margin: "16px 0 8px" }}>Recent Calls</div>
            {d.recentCalls.length ? (
              <Table head={["Date", "Campaign", "Contact", "Phone", "Duration", "Status"]}>
                {d.recentCalls.map((c) => (
                  <tr key={c.id}><td>{fmtDate(c.created_at)}</td><td>{c.campaign_name}</td><td>{c.customer_name || "—"}</td><td>{c.phone}</td><td>{fmtDur(c.duration_sec)}</td><td><StatusBadge status={c.status} /></td></tr>
                ))}
              </Table>
            ) : <div className="card">No calls yet.</div>}
          </>
        )}
      </Boundary>
    </div>
  );
}
