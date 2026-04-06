import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.SYNTHESIS_AGENT_URL ?? "http://localhost:4015";

  try {
    const response = await fetch(`${baseUrl}/v1/internal/synthesized-beliefs`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json({ items: [] }, { status: 200 });
    }

    const payload = (await response.json()) as { items?: unknown[] };
    return NextResponse.json({ items: payload.items ?? [] }, { status: 200 });
  } catch {
    return NextResponse.json({ items: [] }, { status: 200 });
  }
}
