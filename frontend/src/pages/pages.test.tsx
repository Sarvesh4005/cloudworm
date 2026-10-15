import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { deriveMetaKey, encryptMetadata, generateTransferKey, importTransferKey } from "../lib/crypto";

const mockApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getTransfer: vi.fn(),
  createTransfer: vi.fn(),
  getUploadUrls: vi.fn(),
  completeFile: vi.fn(),
  finalize: vi.fn(),
  deleteTransfer: vi.fn(),
  getDownloadUrl: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: mockApi,
}));

const { ReceivePage } = await import("./ReceivePage");
const { SendPage } = await import("./SendPage");

const ID = "AbCdEfGhIjKlMnOpQrStUv";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<SendPage />} />
        <Route path="/t/:transferId" element={<ReceivePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach((m) => m.mockReset());
  localStorage.clear();
  sessionStorage.clear();
});

describe("ReceivePage", () => {
  it("decrypts and shows file names, sizes, counts and expiry", async () => {
    const key = generateTransferKey();
    const meta = await deriveMetaKey(await importTransferKey(key));
    mockApi.getTransfer.mockResolvedValue({
      transferId: ID,
      status: "ready",
      createdAt: 0,
      expiresAt: Math.floor(Date.now() / 1000) + 5 * 3600,
      totalDownloads: 3,
      files: [
        { index: 0, encName: await encryptMetadata(meta, { name: "holiday.jpg", type: "image/jpeg" }), size: 2048, ciphertextSize: 2064, partCount: 1, uploaded: true, downloadCount: 2 },
        { index: 1, encName: await encryptMetadata(meta, { name: "notes.txt", type: "text/plain" }), size: 10, ciphertextSize: 26, partCount: 1, uploaded: true, downloadCount: 1 },
      ],
    });
    renderAt(`/t/${ID}#${key}`);
    expect(await screen.findByText("holiday.jpg")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB · 2 downloads/)).toBeInTheDocument();
    expect(screen.getByText(/in 4 hours|in 5 hours/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download all/ })).toBeInTheDocument();
  });

  it("explains expired links", async () => {
    mockApi.getTransfer.mockRejectedValue(new ApiError(410, "transfer_expired", "expired"));
    renderAt(`/t/${ID}#${generateTransferKey()}`);
    expect(await screen.findByText("This transfer has expired")).toBeInTheDocument();
  });

  it("rejects invalid IDs without calling the API", async () => {
    renderAt(`/t/not-valid#${generateTransferKey()}`);
    expect(await screen.findByText("Invalid link")).toBeInTheDocument();
    expect(mockApi.getTransfer).not.toHaveBeenCalled();
  });

  it("explains a missing key", async () => {
    renderAt(`/t/${ID}`);
    expect(await screen.findByText("Missing decryption key")).toBeInTheDocument();
  });

  it("explains a wrong key", async () => {
    const meta = await deriveMetaKey(await importTransferKey(generateTransferKey()));
    mockApi.getTransfer.mockResolvedValue({
      transferId: ID, status: "ready", createdAt: 0, expiresAt: Date.now() / 1000 + 100, totalDownloads: 0,
      files: [{ index: 0, encName: await encryptMetadata(meta, { name: "x", type: "" }), size: 1, ciphertextSize: 17, partCount: 1, uploaded: true, downloadCount: 0 }],
    });
    renderAt(`/t/${ID}#${generateTransferKey()}`);
    expect(await screen.findByText("Couldn't decrypt")).toBeInTheDocument();
  });
});

describe("SendPage", () => {
  const config = {
    maxFiles: 5, maxFileBytes: 1000, maxTransferBytes: 2000, expiryHoursOptions: [1, 24, 168],
    defaultExpiryHours: 24, allowedExtensions: [], chunkBytes: 8388608, tagBytes: 16, uploadsEnabled: true,
  };

  it("lets the user pick files and expiry, and enforces limits", async () => {
    mockApi.getConfig.mockResolvedValue(config);
    const user = userEvent.setup();
    renderAt("/");
    const send = await screen.findByRole("button", { name: /Encrypt & get link/ });
    expect(send).toBeDisabled();
    expect(screen.getByLabelText("7 days")).toBeInTheDocument();

    await user.upload(screen.getByTestId("file-input"), new File(["hello"], "hello.txt"));
    expect(screen.getByText("hello.txt")).toBeInTheDocument();
    expect(send).toBeEnabled();

    await user.upload(screen.getByTestId("file-input"), new File([new Uint8Array(1500)], "big.bin"));
    expect(screen.getByText(/per-file limit/)).toBeInTheDocument();
    expect(send).toBeDisabled();
  });

  it("shows a clear error for a wrong access code", async () => {
    mockApi.getConfig.mockResolvedValue(config);
    mockApi.createTransfer.mockRejectedValue(new ApiError(401, "invalid_access_code", "bad"));
    const user = userEvent.setup();
    renderAt("/");
    await user.upload(await screen.findByTestId("file-input"), new File(["hello"], "hello.txt"));
    await user.type(screen.getByLabelText("Upload access code"), "wrong");
    await user.click(screen.getByRole("button", { name: /Encrypt & get link/ }));
    expect(await screen.findByText("Wrong access code")).toBeInTheDocument();
  });

  it("shows a retryable error when the API is unreachable", async () => {
    mockApi.getConfig.mockRejectedValue(new ApiError(0, "network_error", "down"));
    renderAt("/");
    expect(await screen.findByText("Connection problem")).toBeInTheDocument();
    mockApi.getConfig.mockResolvedValue(config);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Encrypt & get link/ })).toBeInTheDocument());
  });
});
