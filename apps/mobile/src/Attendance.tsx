import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import * as Crypto from "expo-crypto";
import { brand } from "@rstar/shared";
import { ApiError, api } from "./api";

interface Ev { id: number; kind: string; serverTime: string; result: string; flags: { code: string; label: string }[]; distanceM: number | null }
interface Today {
  date: string; checkedIn: boolean; openSince: string | null; events: Ev[];
  day: { status: string; worked_minutes: number } | null;
  office: { configured: boolean };
  policy: { workStart: string; workEnd: string; allowWfh: boolean; allowField: boolean };
  consent: { given: boolean; version: string };
}
type Mode = "office" | "field" | "wfh";

const t = (v: string | null) => (v ? new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—");

const NOTICE =
  "RSTAR ONE reads your location only when you tap Check in or Check out. There is no background tracking.\n\n" +
  "Your location is compared with your office geofence on the server. Your manager, HR and admins can see the time, distance from the office and accuracy of each check. Unusual check-ins are sent to your manager for review.";

/** Check-in / check-out card. GPS is read once per tap (foreground permission only). */
export function AttendanceCard() {
  const [today, setToday] = useState<Today | null>(null);
  const [mode, setMode] = useState<Mode>("office");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);

  const load = useCallback(async () => {
    try {
      setToday(await api<Today>("/attendance/me/today"));
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not load attendance", tone: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const askConsent = () =>
    new Promise<boolean>((resolve) =>
      Alert.alert("How we use your location", NOTICE, [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "I understand", onPress: () => resolve(true) },
      ]),
    );

  const submit = async () => {
    if (!today) return;
    setMsg(null);
    const kind = today.checkedIn ? "check_out" : "check_in";
    const m: Mode = today.checkedIn ? "office" : mode;
    setBusy(true);
    try {
      if (!today.consent.given) {
        if (!(await askConsent())) return;
        await api("/attendance/consent", { method: "POST", body: {} });
      }
      let fix: { latitude: number; longitude: number; accuracyM: number; mocked: boolean } | null = null;
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status === "granted") {
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        fix = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy ?? 9999), mocked: Boolean(p.mocked) };
      } else if (m !== "wfh") {
        setMsg({ text: "Location permission is needed to check in. You can allow it in your phone settings.", tone: "error" });
        return;
      }
      const ev = await api<Ev>("/attendance/events", {
        method: "POST",
        body: { kind, mode: m, ...(fix ?? {}), clientTime: new Date().toISOString(), idempotencyKey: Crypto.randomUUID() },
      });
      setMsg(
        ev.result === "pending_exception"
          ? { text: `Recorded, but needs review: ${ev.flags.map((f) => f.label).join("; ")}.`, tone: "warn" }
          : { text: `${kind === "check_in" ? "Checked in" : "Checked out"} at ${t(ev.serverTime)}${ev.distanceM != null ? ` · ${Math.round(ev.distanceM)} m from office` : ""}`, tone: "ok" },
      );
      await load();
    } catch (e) {
      setMsg({ text: e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!today) return <View style={s.card}><Text style={s.muted}>{msg?.text ?? "Loading attendance…"}</Text></View>;
  const modes: { key: Mode; label: string }[] = [
    { key: "office", label: "Office" },
    ...(today.policy.allowField ? [{ key: "field" as const, label: "Field" }] : []),
    ...(today.policy.allowWfh ? [{ key: "wfh" as const, label: "WFH" }] : []),
  ];

  return (
    <View style={s.card}>
      <Text style={s.muted}>Today · {today.policy.workStart}–{today.policy.workEnd}</Text>
      <Text style={s.status}>{today.checkedIn ? `Checked in since ${t(today.openSince)}` : today.events.length ? "Checked out" : "Not checked in yet"}</Text>
      {!today.office.configured && <Text style={s.warn}>Office location not set up yet: office check-ins go to review.</Text>}
      {!today.checkedIn && modes.length > 1 && (
        <View style={s.modes} accessibilityRole="radiogroup">
          {modes.map((x) => (
            <Pressable key={x.key} onPress={() => setMode(x.key)} style={[s.mode, mode === x.key && s.modeOn]} accessibilityRole="radio" accessibilityState={{ checked: mode === x.key }}>
              <Text style={{ color: mode === x.key ? "#fff" : brand.ink }}>{x.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Pressable onPress={submit} disabled={busy} style={[s.button, today.checkedIn && s.buttonOut, busy && { opacity: 0.6 }]} accessibilityRole="button">
        <Text style={[s.buttonText, today.checkedIn && { color: brand.ink }]}>{busy ? "Getting location…" : today.checkedIn ? "Check out" : "Check in"}</Text>
      </Pressable>
      {msg && <Text style={msg.tone === "ok" ? s.ok : msg.tone === "warn" ? s.warn : s.error}>{msg.text}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: "#fff", margin: 16, marginBottom: 0, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: brand.border },
  muted: { color: brand.inkMuted, fontSize: 13 },
  status: { color: brand.ink, fontSize: 18, fontWeight: "700", marginTop: 4, marginBottom: 8 },
  modes: { flexDirection: "row", borderWidth: 1, borderColor: brand.border, borderRadius: 10, padding: 2, marginBottom: 10 },
  mode: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  modeOn: { backgroundColor: brand.rstarRed },
  button: { backgroundColor: brand.rstarRed, borderRadius: 10, padding: 14, alignItems: "center" },
  buttonOut: { backgroundColor: "#fff", borderWidth: 1, borderColor: brand.border },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  ok: { color: "#05603A", marginTop: 8 },
  warn: { color: "#93370D", marginTop: 8 },
  error: { color: "#B42318", marginTop: 8 },
});
