import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { PARTNER_SIGNATURE, STAGE_LABELS, brand, type ContentStage } from "@rstar/shared";
import { ApiError, api, login, logout, restoreSession } from "./api";

/**
 * Milestone 1 mobile app: secure sign-in (with MFA), profile and "My work" from the live API.
 * Attendance check-in/out with GPS, leave, payslips and footage upload are added in their milestones;
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
      <Text style={s.section}>MY WORK</Text>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={!refreshing ? <Text style={[s.muted, { textAlign: "center", marginTop: 24 }]}>Nothing assigned to you right now.</Text> : null}
        renderItem={({ item }) => (
          <View style={s.card}>
            <Text style={s.code}>{item.content_code}</Text>
            <Text style={s.itemTitle}>{item.title}</Text>
            <Text style={s.muted}>{STAGE_LABELS[item.stage]}{item.stage_due_at ? ` · due ${new Date(item.stage_due_at).toLocaleDateString("en-IN")}` : ""}</Text>
          </View>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
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
