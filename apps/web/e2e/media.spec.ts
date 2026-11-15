import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test as it, type Page, test } from "@playwright/test";

import {
  addContact,
  befriend,
  createGroup,
  makePng,
  newPerson,
  newSession,
  signUp,
} from "./support";

const SIGNED_URL = /X-Amz-Signature=/u;
const FORWARDED = /Forwarded/u;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Waits until an <img> has really been fetched and decoded by the browser, not just rendered. */
async function expectImageLoaded(page: Page, selector: string) {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate(
          (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth,
        ),
    )
    .toBeGreaterThan(0);
}

/** A link to a chat in the list, by the chat's id. */
function chatLink(page: Page, chatId: string) {
  return page.locator(`a[href="/chat/${chatId}"]`);
}

test.describe("profile photo", () => {
  it("is uploaded to storage, saved on the account and still there after a reload", async ({
    browser,
    request,
  }) => {
    const alice = newPerson("Alice");
    await signUp(request, alice);
    const page = await newSession(browser, alice);

    await page.getByRole("button", { name: "Settings and profile" }).click();
    const profile = page.getByRole("region", { name: "Profile" });
    await profile.getByLabel("Choose a profile photo").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: makePng(300, 200),
    });

    // The upload goes through the web app's /api path, then PATCH /me stores it. The picture the
    // browser then loads comes straight from the storage origin, by a signed link.
    await expect(profile.getByRole("button", { name: "Change photo" })).toBeVisible();
    const avatar = profile.locator("img");
    await expect(avatar).toHaveAttribute("src", SIGNED_URL);
    await expectImageLoaded(page, 'section[aria-label="Profile"] img');

    // The API stores the attachment, not the link, so the next read is signed again.
    await page.reload();
    await page.getByRole("button", { name: "Settings and profile" }).click();
    const after = page.getByRole("region", { name: "Profile" });
    await expect(after.getByRole("button", { name: "Change photo" })).toBeVisible();
    await expect(after.locator("img")).toHaveAttribute("src", SIGNED_URL);
    await expectImageLoaded(page, 'section[aria-label="Profile"] img');
  });
});

test.describe("photos and files", () => {
  it("a photo and a file arrive live, open and download, and can be forwarded", async ({
    browser,
    request,
  }) => {
    const alice = newPerson("Alice");
    const bob = newPerson("Bob");
    const carol = newPerson("Carol");
    const aliceToken = await signUp(request, alice);
    await signUp(request, bob);
    await signUp(request, carol);
    const bobChat = await befriend(request, aliceToken, bob);
    const carolChat = await befriend(request, aliceToken, carol);

    const alicePage = await newSession(browser, alice);
    const bobPage = await newSession(browser, bob);
    const carolPage = await newSession(browser, carol);

    // Alice sends a photo with a caption.
    await alicePage.goto(`/chat/${bobChat}`);
    await alicePage.getByLabel("Choose a file to attach").setInputFiles({
      name: "sunset.png",
      mimeType: "image/png",
      buffer: makePng(640, 480),
    });
    await alicePage.getByLabel("Message", { exact: true }).fill("Look at this");
    await alicePage.getByRole("button", { name: "Send message" }).click();
    // Photos are scaled and saved as JPEG before they are uploaded.
    await expect(alicePage.getByRole("button", { name: "Open photo sunset.jpg" })).toBeVisible();

    // Bob's list gets the chat live. He opens it and looks at the photo full size.
    await chatLink(bobPage, bobChat).click();
    const thumbnail = bobPage.getByRole("button", { name: "Open photo sunset.jpg" });
    await expect(thumbnail).toBeVisible();
    await expect(bobPage.getByRole("main").getByText("Look at this")).toBeVisible();
    await expectImageLoaded(bobPage, 'button[aria-label="Open photo sunset.jpg"] img');
    await thumbnail.click();
    const viewer = bobPage.getByRole("dialog");
    await expect(viewer.locator("img")).toHaveAttribute("src", SIGNED_URL);
    await expectImageLoaded(bobPage, '[role="dialog"] img');
    await bobPage.getByRole("button", { name: "Close photo" }).click();
    await expect(viewer).toBeHidden();

    // Alice sends a file of a few MB, which has to stream through the web app's proxy.
    const report = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < report.length; i += 1) {
      report[i] = (i * 31 + Math.floor(i / 256)) % 251;
    }
    await alicePage.getByLabel("Choose a file to attach").setInputFiles({
      name: "report.bin",
      mimeType: "application/octet-stream",
      buffer: report,
    });
    await alicePage.getByRole("button", { name: "Send message" }).click();
    await expect(alicePage.getByRole("link", { name: "Download report.bin" })).toBeVisible();

    // Bob downloads it and gets the same bytes. The file name comes from the storage headers.
    const download = bobPage.getByRole("link", { name: "Download report.bin" });
    await expect(download).toBeVisible();
    const [saved] = await Promise.all([bobPage.waitForEvent("download"), download.click()]);
    expect(saved.suggestedFilename()).toBe("report.bin");
    const savedPath = await saved.path();
    expect(sha256(await readFile(savedPath))).toBe(sha256(report));

    // Alice forwards the file to Carol. Carol's list gets it live, marked as forwarded, and the
    // attachment is shared: Carol, who did not upload it, can download it too.
    const fileBubble = alicePage
      .getByRole("main")
      .locator("li, div")
      .filter({ has: alicePage.getByRole("link", { name: "Download report.bin" }) })
      .last();
    await fileBubble.hover();
    await alicePage.getByRole("button", { name: "Message actions" }).last().click();
    await alicePage.getByRole("menuitem", { name: "Forward" }).click();
    const dialog = alicePage.getByRole("dialog", { name: "Forward message" });
    await dialog.getByLabel(carol.name).check();
    await dialog.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(dialog).toBeHidden();

    await chatLink(carolPage, carolChat).click();
    await expect(carolPage.getByText(FORWARDED).first()).toBeVisible();
    const carolDownload = carolPage.getByRole("link", { name: "Download report.bin" });
    await expect(carolDownload).toBeVisible();
    const [carolSaved] = await Promise.all([
      carolPage.waitForEvent("download"),
      carolDownload.click(),
    ]);
    expect(sha256(await readFile(await carolSaved.path()))).toBe(sha256(report));
  });
});

test.describe("groups", () => {
  it("a new group, a rename and a new member show up live on other people's screens", async ({
    browser,
    request,
  }) => {
    const alice = newPerson("Alice");
    const bob = newPerson("Bob");
    const carol = newPerson("Carol");
    const dave = newPerson("Dave");
    const aliceToken = await signUp(request, alice);
    await signUp(request, bob);
    await signUp(request, carol);
    await signUp(request, dave);
    const bobContact = await addContact(request, aliceToken, bob);
    const carolContact = await addContact(request, aliceToken, carol);
    await addContact(request, aliceToken, dave);

    const alicePage = await newSession(browser, alice);
    const bobPage = await newSession(browser, bob);
    const davePage = await newSession(browser, dave);

    // Bob has never seen this group. It appears in his list without a reload.
    const name = `Hikers ${Date.now().toString(36)}`;
    const groupId = await createGroup(request, aliceToken, name, [bobContact, carolContact]);
    await expect(chatLink(bobPage, groupId)).toContainText(name);
    await expect(chatLink(davePage, groupId)).toHaveCount(0);

    // Alice renames it from the group info dialog. Bob sees the new name.
    await alicePage.goto(`/chat/${groupId}`);
    await alicePage.getByRole("button", { name: `Group info for ${name}` }).click();
    const renamed = `${name} (summit)`;
    const info = alicePage.getByRole("dialog");
    await info.getByLabel("Group name").fill(renamed);
    await info.getByRole("button", { name: "Save", exact: true }).click();
    await expect(chatLink(bobPage, groupId)).toContainText(renamed);

    // Alice adds Dave. The group appears on Dave's screen.
    await info.getByRole("button", { name: "Add members" }).click();
    await info.getByLabel(dave.name).check();
    await info.getByRole("button", { name: "Add 1" }).click();
    await expect(chatLink(davePage, groupId)).toContainText(renamed);
  });
});
