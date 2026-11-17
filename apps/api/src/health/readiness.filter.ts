import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Response } from "express";

/**
 * Terminus answers an unhealthy readiness check with a 503 whose body says which dependency is
 * down (`{ status, info, error, details }`). Probes and operators need that body, so on the health
 * routes it is sent as it is. The global filter would flatten it to a generic error, which is right
 * for the app's own routes and wrong here.
 */
@Catch(ServiceUnavailableException)
export class ReadinessFilter implements ExceptionFilter {
  catch(exception: ServiceUnavailableException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      return;
    }
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
