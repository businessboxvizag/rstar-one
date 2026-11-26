import { Suspense } from "react";
import { SetPassword } from "@/components/SetPassword";

export const metadata = { title: "Activate account" };

export default function Page() {
  return (
    <Suspense>
      <SetPassword mode="invite" />
    </Suspense>
  );
}
