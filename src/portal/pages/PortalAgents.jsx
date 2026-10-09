import { http } from "../../services/http.js";
import { Boundary, PageHeader, Table, useLoad } from "../ui.jsx";

export default function PortalAgents() {
  const st = useLoad(() => http("/customer/agents"));
  return (
    <div>
      <PageHeader title="Agents" sub="AI voice agents used by your campaigns" />
      <Boundary state={st}>
        {st.data?.length ? (
          <Table head={["Agent", "Type", "Language", "Voice", "Campaigns"]}>
            {st.data.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.agent_type || "—"}</td><td>{a.language || "—"}</td><td>{a.voice || "—"}</td><td>{a.campaigns}</td></tr>)}
          </Table>
        ) : <div className="card">No agents are assigned to your campaigns yet.</div>}
      </Boundary>
    </div>
  );
}
