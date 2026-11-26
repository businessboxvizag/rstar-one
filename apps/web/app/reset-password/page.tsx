import { Suspense } from "react";
import { SetPassword } from "@/components/SetPassword";

export const metadata = { title: "Reset password" };

export default function Page() {
  return (
    <Suspense>
      <SetPassword mode="reset" />
    </Suspense>
  );
}
