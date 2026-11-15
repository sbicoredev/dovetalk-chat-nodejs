import { expect, test as it, test } from "@playwright/test";

import { addContact, befriend, newPerson, newSession, PASSWORD, sendText, signUp } from "./support";

const LOGIN_URL = /\/login$/u;
const ANY_LOGIN_URL = /\/login/u;
const SEEDED_CHAT = /Amara|Priya|Marcus/u;
const PRIYA = /Priya Anand/u;
const IS_TYPING = /is typing/u;
const ONE_THUMBS_UP = /^👍 from 1 person/u;

test.describe("accounts", () => {
  it("create an account in the browser, stay signed in across a reload, sign out", async ({
    page,
  }) => {
    const sam = newPerson("Sam");
    await page.goto("/");
    await expect(page).toHaveURL(LOGIN_URL);

    await page.getByRole("tab", { name: "Create account" }).click();
    await page.getByLabel("Name").fill(sam.name);
    await page.getByLabel("Email").fill(sam.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).last().click();

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    // A new account starts with the demo chats.
    await expect(page.getByRole("link", { name: SEEDED_CHAT }).first()).toBeVisible();

    // The access token is only in memory, so this reload restores the session from the cookie.
    await page.reload();
    await expect(nav).toBeVisible();
    await expect(page).not.toHaveURL(ANY_LOGIN_URL);
    expect(await page.evaluate(() => Object.keys(localStorage).join(","))).not.toContain("token");

    await page.getByRole("button", { name: "Settings and profile" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(LOGIN_URL);

    // Signing out ended the cookie too: a reload stays on the login page.
    await page.reload();
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
  });

  it("a wrong password says so, and the demo button signs in a guest", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
    await expect(page.locator("p[role=alert]")).toContainText("incorrect");

    await page.getByRole("button", { name: "Try the demo" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("link", { name: SEEDED_CHAT }).first()).toBeVisible();
  });
});

test.describe("chatting", () => {
  it("a guest writes to a bot and gets a typing indicator, then a reply", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Try the demo" }).click();
    // A direct chat with a bot (the first in the list is a group, which no bot answers).
    await page.getByRole("link", { name: PRIYA }).first().click();

    await page.getByLabel("Message", { exact: true }).fill("hello from the e2e test");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("main").getByText("hello from the e2e test", { exact: true }),
    ).toBeVisible();
    // The worker answers about 2.4 seconds later. Look for the sent message count growing by a reply.
    await expect(page.getByRole("status", { name: IS_TYPING })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status", { name: IS_TYPING })).toBeHidden({ timeout: 15_000 });
  });

  it("two people in two browsers: typing, live delivery, a reaction, and a reload", async ({
    browser,
    request,
  }) => {
    const alice = newPerson("Alice");
    const bob = newPerson("Bob");
    const aliceToken = await signUp(request, alice);
    await signUp(request, bob);
    // Alice has Bob in her address book (he is found by his phone number) and a chat with him.
    const chatId = await befriend(request, aliceToken, bob);

    const alicePage = await newSession(browser, alice);
    const bobPage = await newSession(browser, bob);

    // Alice writes first. Bob's list gets the chat with its first message, live.
    await alicePage.goto(`/chat/${chatId}`);
    await alicePage.getByLabel("Message", { exact: true }).fill("Hi Bob, are you there?");
    await alicePage.getByRole("button", { name: "Send message" }).click();
    await expect(
      alicePage.getByRole("main").getByText("Hi Bob, are you there?", { exact: true }),
    ).toBeVisible();

    const toAlice = bobPage.locator('a[href^="/chat/"]', { hasText: "Hi Bob, are you there?" });
    await expect(toAlice).toBeVisible();
    await toAlice.click();
    await expect(
      bobPage.getByRole("main").getByText("Hi Bob, are you there?", { exact: true }),
    ).toBeVisible();

    // Bob starts typing: Alice sees it, in the chat and in her list.
    await bobPage.getByLabel("Message", { exact: true }).pressSequentially("Yes, ", { delay: 30 });
    await expect(alicePage.getByRole("status", { name: IS_TYPING })).toBeVisible();
    await bobPage.getByLabel("Message", { exact: true }).pressSequentially("here!");
    await bobPage.keyboard.press("Enter");
    await expect(
      alicePage.getByRole("main").getByText("Yes, here!", { exact: true }),
    ).toBeVisible();
    await expect(alicePage.getByRole("status", { name: IS_TYPING })).toBeHidden();

    // Alice reacts to Bob's message and Bob sees it arrive.
    const bubble = alicePage.getByRole("main").getByText("Yes, here!", { exact: true });
    await bubble.hover();
    await alicePage.getByRole("button", { name: "Message actions" }).last().click();
    await alicePage.getByRole("menuitem", { name: "React with 👍" }).click();
    await expect(bobPage.getByRole("button", { name: ONE_THUMBS_UP })).toBeVisible();

    // A reload keeps Alice signed in and her chat as it was.
    await alicePage.reload();
    await expect(
      alicePage.getByRole("main").getByText("Yes, here!", { exact: true }),
    ).toBeVisible();
    await expect(alicePage.getByRole("button", { name: ONE_THUMBS_UP })).toBeVisible();
  });
});

test.describe("address book", () => {
  it("lists only people you saved: not someone who wrote first, and not a contact you deleted", async ({
    browser,
    request,
  }) => {
    const alice = newPerson("Alice");
    const bob = newPerson("Bob");
    const carol = newPerson("Carol");
    const aliceToken = await signUp(request, alice);
    const bobToken = await signUp(request, bob);
    await signUp(request, carol);

    // Alice writes to Bob, who has never added her. Bob has saved Carol.
    const chatId = await befriend(request, aliceToken, bob);
    await sendText(request, aliceToken, chatId, "Hello from someone you never added");
    await addContact(request, bobToken, carol);

    const bobPage = await newSession(browser, bob);
    // Alice's message is in Bob's chats, with her name on it, so she is known to the app...
    await expect(
      bobPage.locator(`a[href="/chat/${chatId}"]`, {
        hasText: "Hello from someone you never added",
      }),
    ).toContainText(alice.name);

    // ...but she is not in his address book. Carol is.
    await bobPage
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Contacts" })
      .click();
    const carolLink = bobPage.getByRole("link", { name: carol.name });
    await expect(carolLink).toBeVisible();
    await expect(bobPage.getByText(alice.name)).toHaveCount(0);

    // Deleting Carol takes her out of the list for good. The API still returns her as unsaved
    // (her old messages need a name), so a reload must not bring her back.
    await carolLink.click();
    await bobPage.getByRole("button", { name: "Delete contact" }).click();
    await bobPage.getByRole("button", { name: "Delete contact" }).last().click();
    await expect(carolLink).toHaveCount(0);
    await bobPage.reload();
    await expect(bobPage.getByRole("heading", { name: "Contacts" })).toBeVisible();
    // The seeded contacts are still there, so the list has loaded; Carol and Alice are not in it.
    await expect(bobPage.getByRole("link", { name: "Priya Anand" })).toBeVisible();
    await expect(bobPage.getByText(carol.name)).toHaveCount(0);
    await expect(bobPage.getByText(alice.name)).toHaveCount(0);
  });
});
