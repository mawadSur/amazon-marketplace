"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { verifyKyc, razorpayCreateFundAccount } from "@/lib/stubs";
import { runSignupChecks } from "@/lib/fraud";
import { applyBadgeNow } from "@/lib/badges";

// ---- Validation ----------------------------------------------------------

const profileSchema = z.object({
  name: z.string().trim().min(2, "Shop name is too short").max(80),
  city: z.string().trim().min(2).max(60),
  region: z.string().trim().min(2).max(60),
  category: z.enum(["handicrafts", "textiles", "jewelry"]),
  languages: z
    .array(z.string().min(2).max(8))
    .min(1, "Pick at least one language"),
  bio: z.string().trim().max(500).optional().or(z.literal("")),
});

// Government identifier formats (India). Each field is optional (at least one
// required) so we validate format ONLY when a non-empty value is provided,
// mirroring the IFSC regex used for bank details below.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

/** Passes when the value is empty (field omitted) or matches `re`. */
const optionalMatch = (re: RegExp) => (v: string | undefined) => !v || re.test(v);

const kycSchema = z
  .object({
    gstNumber: z
      .string()
      .trim()
      .max(32)
      .refine(optionalMatch(GSTIN_RE), "Enter a valid 15-character GSTIN")
      .optional()
      .or(z.literal("")),
    panNumber: z
      .string()
      .trim()
      .max(16)
      .refine(optionalMatch(PAN_RE), "Enter a valid PAN (e.g. ABCDE1234F)")
      .optional()
      .or(z.literal("")),
    udyamNumber: z
      .string()
      .trim()
      .max(32)
      .refine(optionalMatch(UDYAM_RE), "Enter a valid Udyam number (e.g. UDYAM-XX-00-0000000)")
      .optional()
      .or(z.literal("")),
  })
  .refine(
    (v) => Boolean(v.gstNumber || v.panNumber || v.udyamNumber),
    { message: "Provide at least one of GST / PAN / Udyam." },
  );

const bankSchema = z.object({
  accountHolderName: z.string().trim().min(2).max(80),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{6,18}$/, "Enter a valid bank account number"),
  ifsc: z
    .string()
    .trim()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code"),
});

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

// ---- Helpers -------------------------------------------------------------

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function uniqueShopSlug(base: string) {
  const root = slugify(base) || "shop";
  for (let i = 0; i < 8; i++) {
    const slug = i === 0 ? root : `${root}-${Math.random().toString(36).slice(2, 6)}`;
    const exists = await prisma.shop.findUnique({ where: { slug } });
    if (!exists) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

function fieldErrorsFromZod(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const k = issue.path.join(".") || "_";
    out[k] = out[k] ? [...out[k], issue.message] : [issue.message];
  }
  return out;
}

// ---- Actions -------------------------------------------------------------

export async function submitShopProfile(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  // Promote BUYER → SELLER on first shop creation, since OTP signup defaults are SELLER
  // but other paths may leave the user as BUYER.
  const raw = {
    name: formData.get("name")?.toString() ?? "",
    city: formData.get("city")?.toString() ?? "",
    region: formData.get("region")?.toString() ?? "",
    category: formData.get("category")?.toString() ?? "",
    languages: formData.getAll("languages").map((v) => v.toString()),
    bio: formData.get("bio")?.toString() ?? "",
  };

  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  const existing = await prisma.shop.findUnique({ where: { ownerId: user.id } });
  const slug = existing?.slug ?? (await uniqueShopSlug(parsed.data.name));

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { role: "SELLER" },
    });
    await tx.shop.upsert({
      where: { ownerId: user.id },
      update: {
        name: parsed.data.name,
        city: parsed.data.city,
        region: parsed.data.region,
        category: parsed.data.category,
        languages: parsed.data.languages,
        bio: parsed.data.bio || null,
      },
      create: {
        ownerId: user.id,
        name: parsed.data.name,
        slug,
        city: parsed.data.city,
        region: parsed.data.region,
        category: parsed.data.category,
        languages: parsed.data.languages,
        bio: parsed.data.bio || null,
      },
    });
  });

  revalidatePath("/seller");
  redirect("/seller/onboarding/kyc");
}

export async function submitKyc(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const shop = await prisma.shop.findUnique({ where: { ownerId: user.id } });
  if (!shop) return { ok: false, error: "Complete the shop profile first." };

  const raw = {
    gstNumber: formData.get("gstNumber")?.toString() ?? "",
    panNumber: formData.get("panNumber")?.toString() ?? "",
    udyamNumber: formData.get("udyamNumber")?.toString() ?? "",
  };

  const parsed = kycSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  let result: { verified: boolean; reason?: string };
  try {
    result = await verifyKyc({
      gstNumber: parsed.data.gstNumber || undefined,
      panNumber: parsed.data.panNumber || undefined,
      udyamNumber: parsed.data.udyamNumber || undefined,
    });
  } catch {
    // Provider misconfigured / unavailable (fail-closed): surface a clean error
    // instead of a generic server-action crash, and do not persist a VERIFIED row.
    return { ok: false, error: "KYC verification is temporarily unavailable. Please try again later." };
  }

  const now = new Date();
  await prisma.shopKyc.upsert({
    where: { shopId: shop.id },
    update: {
      gstNumber: parsed.data.gstNumber || null,
      panNumber: parsed.data.panNumber || null,
      udyamNumber: parsed.data.udyamNumber || null,
      status: result.verified ? "VERIFIED" : "REJECTED",
      submittedAt: now,
      verifiedAt: result.verified ? now : null,
      rejectionNote: result.verified ? null : (result.reason ?? "KYC could not be verified"),
    },
    create: {
      shopId: shop.id,
      gstNumber: parsed.data.gstNumber || null,
      panNumber: parsed.data.panNumber || null,
      udyamNumber: parsed.data.udyamNumber || null,
      status: result.verified ? "VERIFIED" : "REJECTED",
      submittedAt: now,
      verifiedAt: result.verified ? now : null,
      rejectionNote: result.verified ? null : (result.reason ?? "KYC could not be verified"),
    },
  });

  if (!result.verified) {
    return { ok: false, error: result.reason ?? "KYC verification failed." };
  }

  revalidatePath("/seller");
  redirect("/seller/onboarding/bank");
}

export async function submitBankAccount(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const shop = await prisma.shop.findUnique({
    where: { ownerId: user.id },
    include: { kyc: true },
  });
  if (!shop) return { ok: false, error: "Complete the shop profile first." };
  if (!shop.kyc || shop.kyc.status !== "VERIFIED") {
    return { ok: false, error: "Complete KYC verification first." };
  }

  const raw = {
    accountHolderName: formData.get("accountHolderName")?.toString() ?? "",
    accountNumber: formData.get("accountNumber")?.toString() ?? "",
    ifsc: formData.get("ifsc")?.toString().toUpperCase() ?? "",
  };

  const parsed = bankSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  const { contactId, fundAccountId } = await razorpayCreateFundAccount({
    name: parsed.data.accountHolderName,
    accountNumber: parsed.data.accountNumber,
    ifsc: parsed.data.ifsc,
  });

  const last4 = parsed.data.accountNumber.slice(-4);

  await prisma.$transaction(async (tx) => {
    await tx.bankAccount.upsert({
      where: { shopId: shop.id },
      update: {
        razorpayContactId: contactId,
        razorpayFundAccountId: fundAccountId,
        accountHolderName: parsed.data.accountHolderName,
        accountNumberLast4: last4,
        ifsc: parsed.data.ifsc,
        verified: true,
      },
      create: {
        shopId: shop.id,
        razorpayContactId: contactId,
        razorpayFundAccountId: fundAccountId,
        accountHolderName: parsed.data.accountHolderName,
        accountNumberLast4: last4,
        ifsc: parsed.data.ifsc,
        verified: true,
      },
    });
    await tx.shop.update({
      where: { id: shop.id },
      data: { status: "PENDING_REVIEW" },
    });
  });

  // Best-effort safety side-effects after signup completes. Both swallow on
  // failure — a fraud-signal write must never block the user from finishing.
  try {
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, phone: true },
    });
    if (fullUser) {
      await runSignupChecks(
        { id: fullUser.id, email: fullUser.email, phone: fullUser.phone },
        { id: shop.id, gstNumber: shop.kyc?.gstNumber, panNumber: shop.kyc?.panNumber },
      );
    }
  } catch {
    /* ignore */
  }
  try {
    await applyBadgeNow(shop.id);
  } catch {
    /* ignore */
  }

  revalidatePath("/seller");
  redirect("/seller/onboarding/done");
}
