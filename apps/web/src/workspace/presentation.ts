import { createContext, useContext } from 'react';

/**
 * How a page is being shown. `page`: a normal page (Classic, or any page over the world but Overview). `world`: Overview inside the Living
 * Workspace, where the camera has flown to the ship and the detailed CoreStage fills the view, so Overview draws its
 * panels over it instead of a second CoreStage card.
 */
export type Presentation = 'page' | 'world';

export const PresentationContext = createContext<Presentation>('page');

export const usePresentation = (): Presentation => useContext(PresentationContext);
