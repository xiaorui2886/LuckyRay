import {markdownLanguage} from '@codemirror/lang-markdown';
export function workspaceOutline(content:string){
 const headings:{level:number;text:string;from:number}[]=[];
 markdownLanguage.parser.parse(content).iterate({enter:node=>{
  const match=/^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);if(!match)return;
  const source=content.slice(node.from,node.to).split('\n')[0];
  headings.push({level:Number(match[1]),text:source.replace(/^\s*#{1,6}\s+/,'').replace(/\s+#+\s*$/,'').trim(),from:node.from});
 }});return headings;
}
