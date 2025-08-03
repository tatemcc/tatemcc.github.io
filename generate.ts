#!/usr/bin/env -S bun run

import { opendir } from "node:fs/promises";

import path from "node:path";
import process from "node:process";

import { micromark } from "micromark";
import { math, mathHtml } from "micromark-extension-math";
import {
  gfmStrikethrough,
  gfmStrikethroughHtml,
} from "micromark-extension-gfm-strikethrough";

import * as cheerio from "cheerio";

import hljs from "highlight.js/lib/common";

import { $ } from "bun";

process.chdir(import.meta.dir);

const src_dir = "src";
const build_dir = "build";
const css_dir = "css";
const css_out_dir = path.join(build_dir, css_dir);
const fonts_out_dir = path.join(css_out_dir, "fonts");
const blog_dir = "blog";
const katex_css_out = "katex.css";
const highlight_css_out = "highlight.css";
const assets_dir = "assets";
const markdown_extension = ".md";
const rss_file = "rss.xml";

await $`rm -rf ${build_dir}`;
await $`mkdir -p ${fonts_out_dir}`;
await $`cp -r ${assets_dir}/* build`;

const node_modules_dir = "node_modules/";
await $`cp ${path.join(node_modules_dir, "highlight.js/styles/base16/gruvbox-dark-medium.min.css")} ${path.join(css_out_dir, highlight_css_out)}`;

const katex_module = path.join(node_modules_dir, "katex/dist");
await $`cp ${path.join(katex_module, "katex.min.css")} ${path.join(css_out_dir, katex_css_out)}`;
await $`cp ${path.join(katex_module, "fonts")}/* ${fonts_out_dir}`;

const complete_page_template = (
  title: string,
  content: string,
) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <meta name="author" content="Tate McCartney">
    <meta name="description" content="Tate McCartney">
    <meta
      name="keywords"
      content="personal, portfolio, website, tate, mccartney, Tate McCartney, engineer"
    >
    <meta name="robots" content="index, follow">

    <link rel="stylesheet" href="${path.join("/", css_dir, katex_css_out)}">

    <link rel="stylesheet" href="${path.join("/", css_dir, "sakura-dark.css")}">

    <link rel="stylesheet" href="${path.join("/", css_dir, highlight_css_out)}">

    <link rel="alternate" type="application/rss+xml" title="RSS" href="/${rss_file}">
  </head>
  <body>
    <main>
    ${content}
    </main>
  </body>
</html>`;

// helper for computing the footnote number in the template
function footnote_number(ix: number): number {
  return ix + 1;
}

const footnote_link_id_template = (ix: number) => `fn_link-${ix}`;

const footnote_id_template = (ix: number) => `fn-${ix}`;

const time_element_template = (thedate: string) =>
  `<time datetime="${thedate}">${thedate}</time>`;

const footnote_link_template = (ix: number) =>
  `<sup id="${footnote_link_id_template(ix)}"><a href="#${footnote_id_template(ix)}">${footnote_number(ix)}</a></sup>`;
async function process_markdown_content(file: Bun.BunFile) {
  const markdown = await file.bytes();
  const converted_html = micromark(markdown, {
    allowDangerousHtml: true,
    extensions: [math(), gfmStrikethrough({ singleTilde: false })],
    htmlExtensions: [mathHtml(), gfmStrikethroughHtml()],
  });

  const $page = cheerio.load(converted_html, {}, false);
  $page('*[class^="language-"]').each(function () {
    const $code = $page(this);
    const html = $code.html();
    if (html === null) {
      throw new Error(); // REVIEW: how can this happen and what's a decent message?
    }

    const lang_class = $code.attr("class");
    if (lang_class === undefined) {
      throw new Error("couldn't find language for code block");
    }
    const language = lang_class.slice("language-".length);

    const highlighted = hljs.highlight(html, { language }).value;

    $code.html(
      cheerio
        .load(highlighted, { xml: { encodeEntities: false } }, false) // don't put html escapes into the highlighted html
        .html(),
    );
  });

  const footnotes = $page("fn")
    .map(function (ix) {
      const $footnote = $page(this);
      const footnote = $footnote.html();
      $footnote.replaceWith(footnote_link_template(ix));
      return footnote;
    })
    .toArray();

  let content = $page.html();
  if (footnotes.length) {
    content += `
<hr/>
<ol style="list-style-type: none; padding-left: 0;">
  ${footnotes
    .map(
      (note, ix) =>
        `<li id="${footnote_id_template(ix)}"><p><sup><a href="#${footnote_link_id_template(ix)}">${footnote_number(ix)}.</a></sup> ${note}</p></li>`,
    )
    .join("\n")}
</ol>`;
  }
  return {
    content,
    title: $page("h1").text(),
  };
}

type Post = {
  title: string;
  folder: string;
  publish_date: string;
  html: string;
};
const posts: Post[] = [];
for await (const dirent of await opendir(path.join(src_dir, blog_dir))) {
  if (!dirent.isFile() || path.extname(dirent.name) != markdown_extension) {
    throw new Error("non-markdown entry in blog");
  }

  const post_content = await process_markdown_content(
    Bun.file(path.join(dirent.parentPath, dirent.name)),
  );
  const $post = cheerio.load(post_content.content, {}, false);

  const pub_date_elem = "publish-date";
  const $pubdate = $post(pub_date_elem);
  const publish_date = $pubdate.text();
  if (publish_date.length !== 0) {
    $pubdate.replaceWith(
      `<strong>${time_element_template(publish_date)}</strong>`,
    );
  }

  let post = {
    title: post_content.title,
    folder: path.join(
      blog_dir,
      dirent.name.slice(0, -markdown_extension.length),
    ),
    publish_date,
    html: $post.html(),
  };
  posts.push(post);

  const post_page = complete_page_template(post.title, post.html);

  Bun.write(path.join(build_dir, post.folder, "index.html"), post_page);
}

{
  const home = await process_markdown_content(
    Bun.file(path.join(src_dir, `index${markdown_extension}`)),
  );
  posts.sort((a, b) => b.publish_date.localeCompare(a.publish_date));
  const $home = cheerio.load(home.content, {}, false);
  $home("#blog-entries").html(`<ul>
  ${posts.map((post) => `<li>${time_element_template(post.publish_date)} - <a href="${path.join("/", post.folder)}">${post.title}</a></li>`).join("\n")}
</ul>
<a href="/rss.xml">RSS Feed</a>`);

  const home_page = complete_page_template(home.title, $home.html());

  Bun.write(path.join(build_dir, "index.html"), home_page);
}

const website_url = "https://tatemccartney.com";
const rss_feed = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">

<channel>
  <title>Tate McCartney</title>
  <link>${website_url}</link>
  <description>Tate McCartney's website and blog</description>
  <language>en-us</language>
  <atom:link href="${website_url}/rss.xml" rel="self" type="application/rss+xml" />
  ${posts
    .map((post) => {
      const date = new Date(post.publish_date);
      const rss_publish_date = date.toUTCString();
      const web_url = path.join(website_url, post.folder);

      return `<item>
  <title>${post.title}</title>
  <link>${web_url}</link>
  <guid>${web_url}</guid>
  <pubDate>${rss_publish_date}</pubDate>
  <description><![CDATA[${post.html}]]></description>
</item>
    `;
    })
    .join("\n")}
</channel>
</rss>`;

Bun.write(path.join(build_dir, rss_file), rss_feed);
