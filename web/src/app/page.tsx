const MOCK_USERS = ["ava", "ben", "chloe", "dan", "elena"];

export default async function Home() {
  let health: unknown = null;
  try {
    const res = await fetch("http://localhost:3001/api/health", {
      cache: "no-store",
    });
    health = await res.json();
  } catch {
    health = { status: "unreachable" };
  }

  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Flight Booking Agent</h1>
      <p>
        Chat UI scaffold. Phase 2 wires this to <code>POST /api/chat</code> on the
        Fastify server (streaming SSE, tool chips, confirm gate).
      </p>
      <p>
        Mock users: {MOCK_USERS.join(", ")} (shared demo PIN <code>4321</code>)
      </p>
      <p>
        API health: <code>{JSON.stringify(health)}</code>
      </p>
    </main>
  );
}
