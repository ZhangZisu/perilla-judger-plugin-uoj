import debug = require("debug");
import { readFileSync, statSync } from "fs";
import { JSDOM } from "jsdom";
import { join } from "path";
import { agent as createAgent } from "superagent";
import { ISolution, JudgeFunction, Problem, Solution, SolutionResult } from "./interfaces";

const MAX_SOURCE_SIZE = 16 * 1024 * 1024;
const UPDATE_INTERVAL = 1000;

const configPath = join(__dirname, "..", "config.json");
const config = JSON.parse(readFileSync(configPath).toString());

const agent = createAgent();
const log = debug("perilla:judger:plugin:uoj");

const isLoggedIn = async () => {
    const result = await agent.get("http://uoj.ac/login") as any;
    return !!result.redirects.length;
};

const initRequest = async () => {
    const loginPage = await agent
        .get("http://uoj.ac/login")
        .set("Host", "uoj.ac")
        .set("Referer", config.uoj_addr)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
    const token = /_token : "([a-zA-Z0-9]+)"/.exec(loginPage.text)[1];
    log(token);
    const md5: any = require(join(__dirname, "uoj_md5"));
    const loginRes = await agent
        .post("http://uoj.ac/login")
        .set("Host", "uoj.ac")
        .set("Referer", "http://uoj.ac/login")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
        .set("X-Requested-With", "XMLHttpRequest")
        .send("_token=" + token)
        .send("login=")
        .send("username=" + config.username)
        .send("password=" + md5(config.password, "uoj233_wahaha!!!!"));
    if (!await isLoggedIn()) { throw new Error("Login failed"); }
    log("Done");
};

const submit = async (id: number, code: string, langname: string) => {
    try {
        const URL = "http://uoj.ac/problem/" + id;
        const problemPage = await agent
            .get(URL)
            .set("Host", "uoj.ac")
            .set("Referer", config.uoj_addr)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36");
        const token = /name=\"_token\" value=\"([a-zA-Z0-9]+)\"/.exec(problemPage.text)[1];
        log(token);
        const preCheck = await agent
            .post(URL)
            .set("Host", "uoj.ac")
            .set("Origin", "http://uoj.ac")
            .set("Referer", URL)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
            .set("X-Requested-With", "XMLHttpRequest");
        const submissions = await agent
            .post(URL)
            .set("Host", "uoj.ac")
            .set("Origin", "http://uoj.ac")
            .set("Referer", URL)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36")
            .send("_token=" + token)
            .send("answer_answer_language=" + langname)
            .send("answer_answer_upload_type=editor")
            .send("answer_answer_editor=" + encodeURIComponent(code))
            .send("submit-answer=answer");
        const dom = new JSDOM(submissions.text);
        const resultTable = dom.window.document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody");
        const resultRows = resultTable.querySelectorAll("tr");
        for (const resultRow of resultRows) {
            if (!resultRow.childNodes[2]) { continue; }
            if (resultRow.childNodes[2].textContent !== config.username) { continue; }
            return parseInt(resultRow.childNodes[0].textContent.trim().substr(1), 10);
        }
        throw new Error("Submit failed");
    } catch (e) {
        throw e;
    }
};
const updateMap = new Map<number, (solution: ISolution) => Promise<void>>();

const convertStatus = (text: string) => {
    try {
        const score = parseInt(text, 10);
        if (score < 0 || score > 100 || isNaN(score)) { throw new Error("Invalid score"); }
        // Cannot parse error
        return {
            score,
            status: score === 100 ? SolutionResult.Accepted : SolutionResult.OtherError,
        };
    } catch (e) {
        switch (text) {
            case "Waiting":
            case "Waiting Rejudge":
                return { status: SolutionResult.WaitingJudge, score: 0 };
            case "Compiling":
            case "Judging":
                return { status: SolutionResult.Judging, score: 0 };
            case "Compile Error":
                return { status: SolutionResult.CompileError, score: 0 };
            case "Judgement Failed":
                return { status: SolutionResult.JudgementFailed, score: 0 };
        }
        return {
            status: SolutionResult.OtherError,
            score: 0,
        };
    }
};

const fetch = async (runID: number) => {
    // const page = await browser.newPage();
    // try {
    //     await page.goto(getURL("submission/" + runID));
    //     const { memory, time, statusText } = await page.evaluate(() => {
    //         const mEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(5)");
    //         const tEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(6)");
    //         const sEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(4)");
    //         return {
    //             memory: mEle.textContent.trim(),
    //             time: tEle.textContent.trim(),
    //             statusText: sEle.textContent.trim(),
    //         };
    //     });
    //     const { status, score } = convertStatus(statusText);
    //     const result: ISolution = {
    //         status,
    //         score,
    //         details: {
    //             time,
    //             memory,
    //             runID,
    //         },
    //     };
    //     await page.close();
    //     return result;
    // } catch (e) {
    //     await page.close();
    //     throw e;
    // }
};

const updateSolutionResults = async () => {
    // for (const [runid, cb] of updateMap) {
    //     try {
    //         const result = await fetch(runid);
    //         cb(result);
    //         if (result.status !== SolutionResult.Judging && result.status !== SolutionResult.WaitingJudge) {
    //             updateMap.delete(runid);
    //         }
    //     } catch (e) {
    //         cb({ status: SolutionResult.JudgementFailed, score: 0, details: { error: e.message, runID: runid } });
    //     }
    // }
    // setTimeout(updateSolutionResults, UPDATE_INTERVAL);
};

const main: JudgeFunction = async (problem, solution, resolve, update) => {
    // if (Problem.guard(problem)) {
    //     if (Solution.guard(solution)) {
    //         if (!browser) {
    //             try {
    //                 await initRequest();
    //             } catch (e) {
    //                 browser = null;
    //                 return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
    //             }
    //         }
    //         try {
    //             let langname = null;
    //             if (solution.language === "c") {
    //                 langname = "C";
    //             } else if (solution.language === "cpp98") {
    //                 langname = "C++";
    //             } else if (solution.language === "cpp11") {
    //                 langname = "C++11";
    //             } else if (solution.language === "java") {
    //                 langname = "Java8";
    //             } else if (solution.language === "python3") {
    //                 langname = "Python3";
    //             } else if (solution.language === "python2") {
    //                 langname = "Python2.7";
    //             }
    //             if (langname === null) {
    //                 return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Language rejected" } });
    //             }
    //             const source = await resolve(solution.file);
    //             const stat = statSync(source.path);
    //             if (stat.size > MAX_SOURCE_SIZE) {
    //                 return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "File is too big" } });
    //             }
    //             const content = readFileSync(source.path).toString();
    //             const runID = await submit(problem.id, content, langname);
    //             updateMap.set(runID, update);
    //         } catch (e) {
    //             return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
    //         }
    //     } else {
    //         return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
    //     }
    // } else {
    //     return update({ status: SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid problem" } });
    // }
};

module.exports = main;

updateSolutionResults();

const test = async () => {
    log(await isLoggedIn());
    await initRequest();
    log("DONE");
};

test();
