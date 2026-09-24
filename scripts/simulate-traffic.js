// scripts/simulate-traffic.js
//
// Simulates varied visitor sessions on the Flowbase landing page to generate
// realistic GA4/GTM event data. Each run picks one of several "visitor
// profiles" at random, each with a different depth of engagement — from
// bouncing off the hero to completing the demo form.

const { chromium } = require("playwright");

const SITE_URL = "https://flowbase-psi.vercel.app/";

// How many sessions to simulate per invocation of this script.
const SESSIONS_PER_RUN = 8;

const FIRST_NAMES = ["Ada", "Grace", "Alan", "Katherine", "Linus", "Margaret", "Tim", "Radia"];
const LAST_NAMES = ["Lovelace", "Hopper", "Turing", "Johnson", "Torvalds", "Hamilton", "Cook", "Perlman"];
const COMPANY_NAMES = ["Northpeak", "Lumen & Co", "Orbital Studio", "Fernway", "Kastle", "Bluewire", "Meridian Labs", "Driftwood Media"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomEmail(firstName, lastName) {
  const domain = pick(["example.com", "mail.com", "test-inbox.dev"]);
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(1, 999)}@${domain}`;
}

// Small human-like pause between actions, so events don't fire in an
// unnaturally tight burst.
async function humanPause(min = 400, max = 1800) {
  await new Promise((resolve) => setTimeout(resolve, randomInt(min, max)));
}

async function scrollDown(page, amount = 600) {
  await page.mouse.wheel(0, amount);
  await humanPause(300, 900);
}

// ---- Visitor profiles -------------------------------------------------

// Just lands on the hero, maybe scrolls a bit, leaves. No conversion events.
async function bouncer(page) {
  await humanPause(500, 1500);
  await scrollDown(page, randomInt(200, 500));
  await humanPause();
}

// Scrolls through the page, opens a couple of FAQ questions, leaves without
// converting. Good for faq_open volume.
async function curiousReader(page) {
  await scrollDown(page, 400);
  await humanPause();

  const faqTriggers = await page.locator('[data-event="feature_expand"], [data-event="faq_open"]').all();
  if (faqTriggers.length > 0) {
    const toOpen = faqTriggers.sort(() => 0.5 - Math.random()).slice(0, randomInt(1, 3));
    for (const trigger of toOpen) {
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await humanPause();
    }
  }

  await scrollDown(page, 300);
}

// Clicks the secondary CTA ("Pricing") from the hero, looks at plans,
// toggles billing, but doesn't select one.
async function pricingBrowser(page) {
  const secondaryCta = page.locator('[data-event="cta_click"][data-cta-type="secondary"]').first();
  if (await secondaryCta.count()) {
    await secondaryCta.click();
    await humanPause();
  } else {
    await scrollDown(page, 900);
  }

  const annualToggle = page.locator('[data-event="toggle_billing"][data-billing-period="annual"]').first();
  if (await annualToggle.count()) {
    await annualToggle.click();
    await humanPause();
  }

  const monthlyToggle = page.locator('[data-event="toggle_billing"][data-billing-period="monthly"]').first();
  if (Math.random() > 0.5 && (await monthlyToggle.count())) {
    await monthlyToggle.click();
    await humanPause();
  }
}

// Full funnel: hero CTA -> selects a plan -> fills and submits the demo form.
async function converter(page) {
  const primaryCta = page.locator('[data-event="cta_click"][data-cta-type="primary"]').first();
  if (await primaryCta.count()) {
    await primaryCta.click();
    await humanPause();
  }

  await scrollDown(page, 700);

  const planButtons = await page.locator('[data-event="select_plan"]').all();
  if (planButtons.length > 0) {
    const chosenPlan = pick(planButtons);
    await chosenPlan.scrollIntoViewIfNeeded();
    await chosenPlan.click();
    await humanPause();
  }

  await fillAndMaybeSubmitDemoForm(page, { submit: true });
}

// Starts the demo form (triggers form_start) but abandons without
// submitting — useful to generate a realistic form_start vs form_submit
// drop-off rate.
async function formAbandoner(page) {
  await scrollDown(page, 1200);
  await fillAndMaybeSubmitDemoForm(page, { submit: false });
}

async function fillAndMaybeSubmitDemoForm(page, { submit }) {
  // The form uses React's useId(), so real DOM ids are dynamic
  // (e.g. ":r0:-name") — select by the stable `name` attribute instead.
  // The newsletter form also has an input[name="email"], so we scope every
  // field to the <form> that owns the "name" input (unique to this form).
  const nameInput = page.locator('input[name="name"]').first();
  if (!(await nameInput.count())) return;

  const demoForm = page.locator("form").filter({ has: nameInput });

  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);

  await nameInput.scrollIntoViewIfNeeded();
  await nameInput.click(); // bubbles up via onFocusCapture on the <form> -> form_start
  await nameInput.fill(`${firstName} ${lastName}`);
  await humanPause();

  const emailInput = demoForm.locator('input[name="email"]').first();
  if (await emailInput.count()) {
    await emailInput.fill(randomEmail(firstName, lastName));
    await humanPause();
  }

  const companyInput = demoForm.locator('input[name="company"]').first();
  if (await companyInput.count()) {
    await companyInput.fill(pick(COMPANY_NAMES));
    await humanPause();
  }

  // Company size is a shadcn/Radix Select: a <button> trigger (its id ends
  // in "-company-size") that opens a listbox with role="option" items, not
  // a native <select>. We pick whichever option happens to be visible
  // rather than matching specific text, since the real labels come from
  // @/data/site and may not match exactly.
  const companySizeTrigger = demoForm.locator('[id$="-company-size"]').first();
  if (await companySizeTrigger.count()) {
    await companySizeTrigger.click();
    await humanPause(200, 500);
    const options = await page.getByRole("option").all();
    if (options.length > 0) {
      await pick(options).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await humanPause();
  }

  if (!submit) return;

  const submitButton = demoForm.getByRole("button", { name: "Request a demo" });
  if (await submitButton.count()) {
    await submitButton.click();
    await humanPause();
  }
}

// Visits, scrolls to the footer, submits the newsletter form only.
// Its email input also uses name="email" (same as the demo request form),
// so we scope every selector inside <footer> to avoid matching the wrong
// form on the page.
async function newsletterSignup(page) {
  await scrollDown(page, 2000);
  await humanPause();

  const newsletterEmail = page.locator('footer input[name="email"]').first();
  if (await newsletterEmail.count()) {
    await newsletterEmail.scrollIntoViewIfNeeded();
    await newsletterEmail.click(); // triggers newsletter_start via focus
    await newsletterEmail.fill(randomEmail(pick(FIRST_NAMES), pick(LAST_NAMES)));
    await humanPause();

    const submitButton = page.getByRole("button", { name: "Subscribe" });
    if (await submitButton.count()) {
      await submitButton.click();
      await humanPause();
    }
  }
}

const PROFILES = [
  { name: "bouncer", weight: 3, run: bouncer },
  { name: "curiousReader", weight: 3, run: curiousReader },
  { name: "pricingBrowser", weight: 2, run: pricingBrowser },
  { name: "converter", weight: 1, run: converter },
  { name: "formAbandoner", weight: 2, run: formAbandoner },
  { name: "newsletterSignup", weight: 1, run: newsletterSignup },
];

function pickWeightedProfile() {
  const totalWeight = PROFILES.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const profile of PROFILES) {
    if (roll < profile.weight) return profile;
    roll -= profile.weight;
  }
  return PROFILES[0];
}

async function runSession(browser, index) {
  const profile = pickWeightedProfile();
  const context = await browser.newContext({
    viewport: { width: randomInt(1280, 1920), height: randomInt(800, 1080) },
    userAgent: undefined, // let Playwright use its default per-browser UA
  });
  const page = await context.newPage();

  console.log(`[session ${index + 1}/${SESSIONS_PER_RUN}] profile: ${profile.name}`);

  try {
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });
    await humanPause(800, 1600);
    await profile.run(page);
  } catch (err) {
    console.error(`[session ${index + 1}] error during "${profile.name}":`, err.message);
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  for (let i = 0; i < SESSIONS_PER_RUN; i++) {
    await runSession(browser, i);
    // Small gap between sessions so events don't all timestamp identically.
    await humanPause(500, 1200);
  }

  await browser.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
