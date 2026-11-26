import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, SectionList, Image, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { PARTNER_SIGNATURE, STAGE_LABELS, TASK_STATUS_LABEL, brand, type ContentStage, type TaskStatus } from "@rstar/shared";
import { ApiError, api, login, logout, restoreSession } from "./api";
import { AttendanceCard } from "./Attendance";

/**
 * Mobile app: secure sign-in (with MFA), GPS attendance check-in/out (Milestone 2), and "My work".
 * Leave screens, payslips and footage upload are added in their milestones;
 * no placeholder buttons are shown for features that do not work yet.
 */
interface Me { user: { displayName: string; email: string }; roles: string[]; organisation: { productName: string } }
interface Item { id: string; content_code: string; title: string; stage: ContentStage; stage_due_at: string | null }

export default function App() {
  const [state, setState] = useState<"loading" | "signedOut" | "signedIn">("loading");
  useEffect(() => {
    restoreSession().then((ok) => setState(ok ? "signedIn" : "signedOut"));
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="dark" />
        {state === "loading" && <ActivityIndicator style={{ flex: 1 }} color={brand.rstarRed} />}
        {state === "signedOut" && <SignIn onDone={() => setState("signedIn")} />}
        {state === "signedIn" && <Home onSignOut={() => setState("signedOut")} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, needTotp ? totp : undefined);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "mfa_required") setNeedTotp(true);
      else setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={s.center}>
      <Image source={require("../assets/rstar-tv-logo.png")} style={{ width: 96, height: 96 }} accessibilityLabel="RSTAR TV" />
      <Text style={s.title}>RSTAR <Text style={{ color: brand.rstarRed }}>ONE</Text></Text>
      <TextInput style={s.input} placeholder="Work email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} accessibilityLabel="Work email" />
      <TextInput style={s.input} placeholder="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} accessibilityLabel="Password" />
      {needTotp && <TextInput style={s.input} placeholder="6-digit authenticator code" keyboardType="number-pad" maxLength={6} value={totp} onChangeText={setTotp} accessibilityLabel="Authenticator code" />}
      {error && <Text style={s.error}>{error}</Text>}
      <Pressable style={[s.button, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy || !email || !password} accessibilityRole="button">
        <Text style={s.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
      </Pressable>
      <Text style={s.partner}>{PARTNER_SIGNATURE}</Text>
    </View>
  );
}

function Home({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const m = await api<Me>("/me");
      setMe(m);
      const r = await api<{ items: Item[] }>("/content?mine=true&limit=30").catch(() => ({ items: [] }));
      setItems(r.items);
      const t = await api<{ items: Task[] }>("/tasks?view=mine").catch(() => ({ items: [] as Task[] }));
      setTasks(t.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <View>
          <Text style={s.hello}>{me ? `Hi, ${me.user.displayName.split(" ")[0]}` : " "}</Text>
          <Text style={s.muted}>{me?.roles.join(", ").replace(/_/g, " ")}</Text>
        </View>
        <Pressable onPress={async () => { await logout(); onSignOut(); }} accessibilityRole="button"><Text style={{ color: brand.rstarRed }}>Sign out</Text></Pressable>
      </View>
      {error && <Text style={[s.error, { margin: 16 }]}>{error}</Text>}
      <AttendanceCard />
      <SectionList<Row, { key: string; title: string; data: Row[] }>
        sections={[
          { key: "tasks", title: "MY TASKS", data: tasks.map((t): Row => ({ kind: "task", t })) },
          { key: "content", title: "MY CONTENT", data: items.map((c): Row => ({ kind: "content", c })) },
        ]}
        keyExtractor={(x) => (x.kind === "task" ? `t${x.t.id}` : `c${x.c.id}`)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderSectionFooter={({ section }) =>
          !section.data.length && !refreshing ? <Text style={[s.muted, { marginHorizontal: 16 }]}>{section.key === "tasks" ? "No open tasks." : "No content assigned to you."}</Text> : null}
        stickySectionHeadersEnabled={false}
        renderItem={({ item }) =>
          item.kind === "task" ? (
            <TaskRow t={item.t} onChanged={load} />
          ) : (
            <View style={s.card}>
              <Text style={s.code}>{item.c.content_code}</Text>
              <Text style={s.itemTitle}>{item.c.title}</Text>
              <Text style={s.muted}>{STAGE_LABELS[item.c.stage]}{item.c.stage_due_at ? ` · due ${new Date(item.c.stage_due_at).toLocaleDateString("en-IN")}` : ""}</Text>
            </View>
          )
        }
      />
    </View>
  );
}

type Row = { kind: "task"; t: Task } | { kind: "content"; c: Item };

interface Task {
  id: string; number: number; title: string; status: TaskStatus; priority: string; dueDate: string | null; overdue: boolean;
  createdBy: { name: string; isMe: boolean }; version: number;
}

function TaskRow({ t, onChanged }: { t: Task; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const next: TaskStatus | null = t.status === "open" || t.status === "blocked" ? "in_progress" : t.status === "in_progress" ? "done" : null;
  const set = async (status: TaskStatus) => {
    setBusy(true);
    try {
      await api(`/tasks/${t.id}/status`, { method: "POST", body: { status, expectedVersion: t.version } });
      onChanged();
    } catch (e) {
      Alert.alert("Could not update", e instanceof Error ? e.message : "Please try again");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={s.card}>
      <Text style={s.muted}>T-{t.number} · from {t.createdBy.isMe ? "you" : t.createdBy.name}{t.priority === "urgent" || t.priority === "high" ? ` · ${t.priority}` : ""}</Text>
      <Text style={s.itemTitle}>{t.title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <Text style={[s.muted, t.overdue && { color: "#B42318", fontWeight: "600" }]}>
          {TASK_STATUS_LABEL[t.status]}{t.dueDate ? ` · due ${new Date(`${t.dueDate}T00:00:00`).toLocaleDateString("en-IN")}` : ""}{t.overdue ? " · overdue" : ""}
        </Text>
        {next && (
          <Pressable onPress={() => void set(next)} disabled={busy} style={[s.small, busy && { opacity: 0.5 }]} accessibilityRole="button">
            <Text style={{ color: "#fff", fontWeight: "600" }}>{next === "done" ? "Mark done" : t.status === "blocked" ? "Resume" : "Start"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  small: { backgroundColor: brand.rstarRed, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  root: { flex: 1, backgroundColor: brand.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: brand.surface },
  title: { fontSize: 24, fontWeight: "700", color: brand.ink, marginTop: 8, marginBottom: 24 },
  input: { width: "100%", maxWidth: 380, borderWidth: 1, borderColor: brand.border, borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 16, backgroundColor: "#fff" },
  button: { width: "100%", maxWidth: 380, backgroundColor: brand.rstarRed, borderRadius: 10, padding: 14, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  error: { color: "#B42318", marginBottom: 8 },
  partner: { position: "absolute", bottom: 24, fontSize: 12, color: brand.bboxAccent },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, backgroundColor: "#fff", borderBottomWidth: 1, borderColor: brand.border },
  hello: { fontSize: 20, fontWeight: "700", color: brand.ink },
  muted: { color: brand.inkMuted, fontSize: 13 },
  section: { marginHorizontal: 16, marginTop: 16, marginBottom: 8, fontSize: 12, fontWeight: "600", color: brand.inkMuted, letterSpacing: 0.5 },
  card: { backgroundColor: "#fff", marginHorizontal: 16, marginBottom: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: brand.border },
  code: { color: brand.rstarRed, fontWeight: "700", fontFamily: "monospace" },
  itemTitle: { color: brand.ink, fontSize: 15, fontWeight: "600", marginVertical: 2 },
});
