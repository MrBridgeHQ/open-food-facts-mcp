import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createService, ServiceError, type Config } from './service.ts';

const barcode = z.string().regex(/^[0-9]{4,32}$/);
const language = z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/).optional();
const page = z.number().int().min(1).max(1000).optional();
const pageSize = z.number().int().min(1).max(20).optional();
const safeTag = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/).optional();
const output = z.object({source:z.object({service:z.string(),api_version:z.string(),url:z.string()}),retrieved_at:z.string(),cache_hit:z.boolean(),data:z.unknown(),missing_fields:z.array(z.string()),warnings:z.array(z.string())});
const annotations = { readOnlyHint:true, idempotentHint:true, destructiveHint:false, openWorldHint:true } as const;

function result(value: unknown) { return { content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value as Record<string,unknown> }; }
async function handle(promise: Promise<unknown>) {
  try { return result(await promise); }
  catch (e) { const error=e instanceof ServiceError ? {code:e.code,message:e.message,retry_after_seconds:e.retry_after_seconds ?? null} : {code:'INTERNAL',message:'Unexpected server error'};
    return {content:[{type:'text' as const,text:JSON.stringify({error})}],structuredContent:{error},isError:true}; }
}

export function createMcpServer(config: Config) {
  const service=createService(config);
  const server=new McpServer({name:'open-food-facts-mcp',version:'0.1.0'});
  server.registerTool('get_product',{description:'Read one Open Food Facts product by barcode. Nutrition and allergen data are informational.',inputSchema:z.object({barcode,language}),outputSchema:output,annotations},args=>handle(service.getProduct(args)));
  server.registerTool('search_products',{description:'Search Open Food Facts products with documented taxonomy filters.',inputSchema:z.object({country:safeTag,category:safeTag,brand:safeTag,nutriscore:z.enum(['a','b','c','d','e']).optional(),page,page_size:pageSize,language}),outputSchema:output,annotations},args=>handle(service.searchProducts(args)));
  server.registerTool('search_text',{description:'Full text product search via Search-a-licious.',inputSchema:z.object({query:z.string().min(1).max(120),page,page_size:pageSize,language}),outputSchema:output,annotations},args=>handle(service.searchText(args)));
  server.registerTool('get_taxonomy',{description:'Autocomplete an Open Food Facts taxonomy.',inputSchema:z.object({query:z.string().min(1).max(100),taxonomy:z.enum(['categories','brands','countries','ingredients','additives','allergens','labels']),language,limit:z.number().int().min(1).max(20).optional()}),outputSchema:output,annotations},args=>handle(service.getTaxonomy(args)));
  server.registerTool('compare_products',{description:'Compare 2–5 products only when normalized nutrition basis and preparation match.',inputSchema:z.object({barcodes:z.array(barcode).min(2).max(5),language}),outputSchema:output,annotations},args=>handle(service.compareProducts(args)));
  return server;
}
