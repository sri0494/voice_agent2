import { useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";

export default function ContactUs() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", subject: "", message: "" });
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState("");

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");
    try {
      await api.sendContactRequest(form);
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Something went wrong. Please try again.");
    }
  };

  if (status === "sent") {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
          <div className="section-title">Thanks for reaching out</div>
          <div className="section-sub">We've received your message and will be in touch shortly.</div>
          <Link to="/login" className="btn btn-primary" style={{ marginTop: 10, display: "inline-flex" }}>Back to Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-card" style={{ maxWidth: 440 }}>
        <div className="sidebar-logo" style={{ padding: 0, marginBottom: 18, justifyContent: "center" }}>
          <div className="sidebar-logo-mark">LX</div>
          <span style={{ fontSize: 20 }}>LeoMox</span>
        </div>
        <div className="section-title" style={{ textAlign: "center" }}>Get in Touch</div>
        <div className="section-sub" style={{ textAlign: "center" }}>Tell us about your use case and we'll follow up.</div>

        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Name</label><input className="input" required value={form.name} onChange={set("name")} /></div>
            <div className="form-group"><label>Email</label><input className="input" type="email" required value={form.email} onChange={set("email")} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Phone</label><input className="input" value={form.phone} onChange={set("phone")} /></div>
            <div className="form-group"><label>Company</label><input className="input" value={form.company} onChange={set("company")} /></div>
          </div>
          <div className="form-group"><label>Subject</label><input className="input" value={form.subject} onChange={set("subject")} /></div>
          <div className="form-group"><label>Message</label><textarea className="input" rows={4} required value={form.message} onChange={set("message")} /></div>

          {status === "error" && <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 14 }}>{errorMsg}</div>}

          <button className="btn btn-primary" type="submit" style={{ width: "100%" }} disabled={status === "sending"}>
            {status === "sending" ? "Sending..." : "Send Message"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 16 }}>
          <Link to="/login" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Login</Link>
        </div>
      </div>
    </div>
  );
}
