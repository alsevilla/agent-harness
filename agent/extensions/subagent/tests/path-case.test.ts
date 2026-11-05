// One case rule for paths: Windows and macOS fold case, Linux keeps it.
import assert from "node:assert/strict";
import test from "node:test";
import { foldCase, foldsCase } from "../path-case.ts";

test("Windows and macOS fold path case; Linux keeps it", () => {
	assert.equal(foldsCase("win32"), true);
	assert.equal(foldsCase("darwin"), true);
	assert.equal(foldsCase("linux"), false);
	assert.equal(foldCase("/Users/Me/Repo/.ENV", "darwin"), "/users/me/repo/.env");
	assert.equal(foldCase("C:/Work/App", "win32"), "c:/work/app");
	assert.equal(foldCase("/home/Me/Repo", "linux"), "/home/Me/Repo");
});
