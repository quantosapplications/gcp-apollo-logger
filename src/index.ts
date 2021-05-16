import { ApolloServerPlugin, BaseContext, GraphQLRequestContext, GraphQLRequestContextWillSendResponse } from 'apollo-server-plugin-base';
import winston from 'winston';
import { LoggingWinston } from '@google-cloud/logging-winston';

let loggingWinston: LoggingWinston;
let logger: winston.Logger;

// Consente di estrarre l'utente richiedente dalla request e scriverlo nei log
let _extractUserFromContext: (ctx: BaseContext) => any | undefined;

// Cerca di estrarre il nome dell'operazione graphql dal context
const _extractOperationNameFromContext = (ctx: GraphQLRequestContext): string | undefined => {
  if (ctx.request.operationName) { return ctx.request.operationName; }
  else if (ctx.request.query) { 
    // TODO tirare fuori il nome della query query { getEntity(..) { ... } } => getEntity
  }
};

// Inizializzazione del logger
const _initLogger = () => {

  // serviceContext se è valorizzato riporta gli errori anche su Error Reporting
  const serviceContext = process.env.SERVICE_NAME ? { service: process.env.SERVICE_NAME } : undefined;

  loggingWinston = new LoggingWinston({
    serviceContext
  });

  // Transports - se in debug scriviamo anche nella console
  const transports: winston.transport[] = [];
  if (process.env.NODE_ENV === 'development') { transports.push(new winston.transports.Console()); }
  transports.push(loggingWinston);

  logger = winston.createLogger({
    level: 'info',
    transports
  });
};

// Metodo principale
// Formatta e scrive i log
const _handleLog = (log: Object | string | Error, severity: 'ERROR' | 'WARNING' | 'INFO', ctx?: GraphQLRequestContext, reqUser?: any)  => {

  if (!logger) { _initLogger(); }

  let message = '';
  let metadata: any = {};

  if (log instanceof Error || log instanceof Object) { metadata = log; }
  
  if (ctx) {

    message += _extractOperationNameFromContext(ctx) + ' - '; 

    // Http request info
    metadata.httpRequest = {
      status: severity === 'ERROR' ? 500 : severity === 'WARNING' ? 400 : 200,
      requestUrl: `${ctx.context.req.protocol}://${ctx.context.req.hostname}${ctx.context.req.originalUrl}`,
      requestMethod: ctx.context.req.method,
      remoteIp: ctx.context.req.socket.remoteAddress,
      requestSize: ctx.context.req.socket.bytesRead,
      userAgent: ctx.context.req.headers && ctx.context.req.headers['user-agent']
    };

    // Tracing
    if (ctx.context.req.headers && ctx.context.req.headers['X-Cloud-Trace-Context']) {
      const [trace] = `${ctx.context.req.headers['X-Cloud-Trace-Context']}`.split('/');
      metadata.httpRequest[LoggingWinston.LOGGING_TRACE_KEY] = `projects/${process.env.PROJECT_ID}/traces/${trace}`;
    }

    // Graphql request
    metadata.graphqlRequest = ctx.request;
  }

  if (reqUser) {
    metadata.reqUser = reqUser;
  }
  else if (_extractUserFromContext) {
    metadata.reqUser = _extractUserFromContext(ctx);
  }

  if (typeof(log) === 'string') { message += log; }
  else if (log instanceof Error) { message += log.message; }
  else { message += JSON.stringify(log, Object.getOwnPropertyNames(log)); }

  switch (severity) {
    case 'ERROR': logger.error(message, metadata); break;
    case 'WARNING': logger.warn(message, metadata); break;
    default: logger.info(message, metadata); break;
  }
  
};

// exported - per chiamare il logger coome se fosse static
export const GcpApolloLogger = {
  log(log: Object | string, ctx?: GraphQLRequestContext, reqUser?: any): void {
    _handleLog(log, 'INFO', ctx, reqUser);
  },
  warn(log: Object | string | Error, ctx?: GraphQLRequestContext, reqUser?: any): void {
    _handleLog(log, 'WARNING', ctx, reqUser);
  },
  error(log: Error, ctx?: GraphQLRequestContext, reqUser?: any): void {
    _handleLog(log, 'ERROR', ctx, reqUser);
  },
  init(config: { extractUserFromContext: (ctx: GraphQLRequestContext) => any }): void {
    if (config.extractUserFromContext) {
      _extractUserFromContext = config.extractUserFromContext;
    }
    
  }
};

export class GcpApolloLoggerPlugin implements ApolloServerPlugin {

  requestDidStart = (ctx: GraphQLRequestContext) => {

    if (ctx.request.operationName === 'IntrospectionQuery') { return {}; }

    _handleLog('Started request', 'INFO', ctx);

    return {
      willSendResponse: (resCtx: GraphQLRequestContextWillSendResponse<BaseContext>) => {
        if (resCtx.errors) {
          for (const error of resCtx.errors) {
            _handleLog(error, 'ERROR', resCtx);
          }
        }
        else {
          _handleLog('Finished request', 'INFO', resCtx.context.req);
        }
      }
    };
  }
}
